import mongoose from "mongoose";

import {
  UserPlanHistoryModel,
  type UserPlanHistoryKind,
  type UserPlanHistoryLean,
} from "../models/UserPlanHistory.js";

export type PlanHistoryEntry = {
  id: string;
  kind: UserPlanHistoryKind;
  label: string;
  planSlug: string;
  planName: string;
  planExpiresAt: string | null;
  toPlanSlug: string | null;
  toPlanName: string | null;
  actor: "admin" | "system";
  occurredAt: string;
};

function toIso(d: unknown): string | null {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(String(d));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function formatDateLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function formatPlanHistoryLabel(entry: {
  kind: UserPlanHistoryKind;
  planName: string;
  planExpiresAt: string | null;
  toPlanName: string | null;
}): string {
  if (entry.kind === "expired") {
    const at = entry.planExpiresAt ? ` at ${formatDateLabel(entry.planExpiresAt)}` : "";
    return `${entry.planName} expired${at}`;
  }
  if (entry.kind === "downgraded") {
    const target = entry.toPlanName ?? "default plan";
    const at = entry.planExpiresAt ? ` at ${formatDateLabel(entry.planExpiresAt)}` : "";
    return `Downgraded to ${target} (${entry.planName} expired${at})`;
  }
  const expiry = entry.planExpiresAt
    ? `, expires ${formatDateLabel(entry.planExpiresAt)}`
    : " (no expiry)";
  return `Assigned plan ${entry.planName}${expiry}`;
}

function docToEntry(doc: UserPlanHistoryLean & { _id: mongoose.Types.ObjectId }): PlanHistoryEntry {
  const planExpiresAt = toIso(doc.planExpiresAt);
  const kind = doc.kind as UserPlanHistoryKind;
  const entry = {
    kind,
    planName: String(doc.planName),
    planExpiresAt,
    toPlanName: doc.toPlanName != null ? String(doc.toPlanName) : null,
  };
  return {
    id: doc._id.toString(),
    kind,
    label: formatPlanHistoryLabel(entry),
    planSlug: String(doc.planSlug),
    planName: String(doc.planName),
    planExpiresAt,
    toPlanSlug: doc.toPlanSlug != null ? String(doc.toPlanSlug) : null,
    toPlanName: doc.toPlanName != null ? String(doc.toPlanName) : null,
    actor: doc.actor === "admin" ? "admin" : "system",
    occurredAt: toIso(doc.createdAt) ?? new Date().toISOString(),
  };
}

type AppendInput = {
  userId: mongoose.Types.ObjectId | string;
  kind: UserPlanHistoryKind;
  planSlug: string;
  planName: string;
  planExpiresAt?: Date | null;
  toPlanSlug?: string | null;
  toPlanName?: string | null;
  actor: "admin" | "system";
  adminUserId?: mongoose.Types.ObjectId | string | null;
};

export async function appendUserPlanHistory(input: AppendInput): Promise<void> {
  await UserPlanHistoryModel.create({
    userId: input.userId,
    kind: input.kind,
    planSlug: input.planSlug,
    planName: input.planName,
    planExpiresAt: input.planExpiresAt ?? null,
    toPlanSlug: input.toPlanSlug ?? null,
    toPlanName: input.toPlanName ?? null,
    actor: input.actor,
    adminUserId: input.adminUserId ?? null,
  });
}

export async function listUserPlanHistory(
  userId: string,
  limit = 50,
): Promise<PlanHistoryEntry[]> {
  if (!mongoose.Types.ObjectId.isValid(userId)) return [];
  const docs = (await UserPlanHistoryModel.find({ userId })
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 100))
    .lean()) as Array<UserPlanHistoryLean & { _id: mongoose.Types.ObjectId }>;
  return docs.map(docToEntry);
}

export async function recordAdminPlanAssignment(input: {
  userId: mongoose.Types.ObjectId | string;
  planSlug: string;
  planName: string;
  planExpiresAt: Date | null;
  adminUserId: mongoose.Types.ObjectId | string;
}): Promise<void> {
  await appendUserPlanHistory({
    userId: input.userId,
    kind: "assigned",
    planSlug: input.planSlug,
    planName: input.planName,
    planExpiresAt: input.planExpiresAt,
    actor: "admin",
    adminUserId: input.adminUserId,
  });
}
