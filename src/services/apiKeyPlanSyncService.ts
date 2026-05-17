import mongoose from "mongoose";

import { ApiKeyModel } from "../models/ApiKey.js";
import { UserModel } from "../models/User.js";
import { resolvePlanForUser } from "./planRegistry.js";

export type SyncUserApiKeysResult = {
  primaryId: string | null;
  enabled: number;
  disabled: number;
  primariesAssigned: number;
};

export type SyncAllUsersApiKeysResult = {
  usersProcessed: number;
  keysEnabled: number;
  keysDisabled: number;
  primariesAssigned: number;
};

function readMaxApiKeysForUser(planRef: unknown): number {
  const plan = resolvePlanForUser(planRef);
  if (!plan) return 1;
  const n = plan.maxApiKeys;
  if (!Number.isFinite(n) || n < 0) return 1;
  return n;
}

/**
 * Aligns non-revoked API keys with the user's plan: one primary (oldest if unset),
 * up to maxApiKeys enabled (primary first, then oldest), rest disabled.
 */
export async function syncUserApiKeysToPlan(
  userId: mongoose.Types.ObjectId,
): Promise<SyncUserApiKeysResult> {
  const user = await UserModel.findById(userId).select("plan").lean();
  const maxEnabled = readMaxApiKeysForUser(user?.plan);

  const keys = await ApiKeyModel.find({ userId, revokedAt: null })
    .sort({ createdAt: 1 })
    .select("_id primaryKey isDisabled createdAt")
    .lean();

  if (keys.length === 0) {
    return { primaryId: null, enabled: 0, disabled: 0, primariesAssigned: 0 };
  }

  let primariesAssigned = 0;
  const primaryCandidates = keys.filter((k) => k.primaryKey === true);
  let primaryId: mongoose.Types.ObjectId;

  if (primaryCandidates.length === 0) {
    primaryId = keys[0]!._id as mongoose.Types.ObjectId;
    primariesAssigned = 1;
  } else if (primaryCandidates.length === 1) {
    primaryId = primaryCandidates[0]!._id as mongoose.Types.ObjectId;
  } else {
    const sorted = [...primaryCandidates].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    primaryId = sorted[0]!._id as mongoose.Types.ObjectId;
    primariesAssigned = 1;
  }

  const ranked = [
    ...keys.filter((k) => String(k._id) === String(primaryId)),
    ...keys.filter((k) => String(k._id) !== String(primaryId)),
  ];

  const enableIds = new Set<string>();
  for (const k of ranked) {
    if (enableIds.size >= maxEnabled) break;
    enableIds.add(String(k._id));
  }
  enableIds.add(String(primaryId));

  let enabled = 0;
  let disabled = 0;

  for (const k of keys) {
    const id = String(k._id);
    const shouldEnable = enableIds.has(id);
    const nextPrimary = id === String(primaryId);
    const nextDisabled = !shouldEnable;

    const needsUpdate =
      k.primaryKey !== nextPrimary ||
      Boolean(k.isDisabled) !== nextDisabled;

    if (needsUpdate) {
      await ApiKeyModel.updateOne(
        { _id: k._id },
        { $set: { primaryKey: nextPrimary, isDisabled: nextDisabled } },
      );
    }

    if (nextDisabled) disabled += 1;
    else enabled += 1;
  }

  return {
    primaryId: String(primaryId),
    enabled,
    disabled,
    primariesAssigned,
  };
}

/** Backfill / reconcile every user that has at least one non-revoked API key. */
export async function syncAllUsersApiKeysToPlans(): Promise<SyncAllUsersApiKeysResult> {
  const userIds = await ApiKeyModel.distinct("userId", { revokedAt: null });

  let usersProcessed = 0;
  let keysEnabled = 0;
  let keysDisabled = 0;
  let primariesAssigned = 0;

  for (const rawId of userIds) {
    const userId =
      rawId instanceof mongoose.Types.ObjectId
        ? rawId
        : new mongoose.Types.ObjectId(String(rawId));
    const result = await syncUserApiKeysToPlan(userId);
    usersProcessed += 1;
    keysEnabled += result.enabled;
    keysDisabled += result.disabled;
    primariesAssigned += result.primariesAssigned;
  }

  return { usersProcessed, keysEnabled, keysDisabled, primariesAssigned };
}
