import mongoose from "mongoose";

import { UserModel } from "../models/User.js";
import { syncUserApiKeysToPlan } from "./apiKeyPlanSyncService.js";
import {
  getDefaultPlanFromRegistry,
  getPlanByIdFromRegistry,
  isUserPlanExpired,
  resolvePlanForUser,
} from "./planRegistry.js";
import { appendUserPlanHistory } from "./userPlanHistoryService.js";

/** If assigned non-default plan is past expiry, downgrade to default and log history. */
export async function applyExpiredPlanDowngradeIfNeeded(
  userId: mongoose.Types.ObjectId | string,
): Promise<boolean> {
  const user = await UserModel.findById(userId).select("plan planExpiresAt");
  if (!user) return false;

  const assigned = resolvePlanForUser(user.plan);
  if (!assigned || assigned.isDefault) return false;
  if (!isUserPlanExpired({ plan: user.plan, planExpiresAt: user.planExpiresAt })) return false;

  const defaultPlan = getDefaultPlanFromRegistry();
  if (!defaultPlan) return false;

  const expiredAt =
    user.planExpiresAt instanceof Date
      ? user.planExpiresAt
      : user.planExpiresAt
        ? new Date(user.planExpiresAt)
        : new Date();

  const updated = await UserModel.updateOne(
    {
      _id: user._id,
      plan: user.plan,
      planExpiresAt: user.planExpiresAt,
    },
    {
      $set: {
        plan: new mongoose.Types.ObjectId(defaultPlan.id),
        planExpiresAt: null,
      },
    },
  );
  if (updated.modifiedCount === 0) return false;

  await appendUserPlanHistory({
    userId: user._id,
    kind: "expired",
    planSlug: assigned.slug,
    planName: assigned.name,
    planExpiresAt: expiredAt,
    actor: "system",
  });
  await appendUserPlanHistory({
    userId: user._id,
    kind: "downgraded",
    planSlug: assigned.slug,
    planName: assigned.name,
    planExpiresAt: expiredAt,
    toPlanSlug: defaultPlan.slug,
    toPlanName: defaultPlan.name,
    actor: "system",
  });

  await syncUserApiKeysToPlan(user._id);
  return true;
}

export function planSnapshotFromId(planId: unknown): { slug: string; name: string } | null {
  if (planId == null) return null;
  const id =
    typeof planId === "object" && planId !== null && "_id" in planId
      ? (planId as { _id: mongoose.Types.ObjectId })._id.toString()
      : String(planId);
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const snap = getPlanByIdFromRegistry(id);
  return snap ? { slug: snap.slug, name: snap.name } : null;
}
