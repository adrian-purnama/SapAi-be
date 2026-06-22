import mongoose, { type Types } from "mongoose";

import { DEFAULT_TASK_ACCESS } from "../constants/taskCatalog.js";
import { PlanModel, type PlanLean } from "../models/Plan.js";

export type PlanSnapshot = {
  id: string;
  slug: string;
  name: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
  isDefault: boolean;
  isPriority: boolean;
  rateLimitPerMinute: number;
  maxCharacterPerMessage: number;
  maxChatInFlight: number;
  maxApiKeys: number;
  maxPdfUpload: number;
  maxPdfMb: number;
  analyticsRetentionDays: number;
  isAutoEmbed: boolean;
  embedBadgeCustomizable: boolean;
  ragAnalyticsEnabled: boolean;
  priceLabel: string | null;
  priceNote: string | null;
  taskAccess: Record<string, string[]>;
  createdAt: string | null;
  updatedAt: string | null;
};

type PlanDoc = PlanLean & { _id: Types.ObjectId };

let bySlug = new Map<string, PlanSnapshot>();
let ordered: PlanSnapshot[] = [];
let defaultSlug: string | null = null;
let registryLoaded = false;

function toIso(d: unknown): string | null {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(String(d));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function normalizeTaskAccessFromDoc(doc: PlanDoc): Record<string, string[]> {
  const raw = (doc as { taskAccess?: unknown }).taskAccess;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_TASK_ACCESS };
  }
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const labels = value.map((v) => String(v).trim()).filter(Boolean);
    if (labels.length > 0) out[key] = labels;
  }
  return Object.keys(out).length > 0 ? out : { ...DEFAULT_TASK_ACCESS };
}

export function planDocToSnapshot(doc: PlanDoc): PlanSnapshot {
  return {
    id: doc._id.toString(),
    slug: String(doc.slug),
    name: String(doc.name),
    description: String(doc.description ?? ""),
    isActive: Boolean(doc.isActive),
    sortOrder: Number(doc.sortOrder ?? 0),
    isDefault: Boolean(doc.isDefault),
    isPriority: Boolean(doc.isPriority),
    rateLimitPerMinute: Number(doc.rateLimitPerMinute ?? 60),
    maxCharacterPerMessage: Number(doc.maxCharacterPerMessage ?? 2000),
    maxChatInFlight: Number(doc.maxChatInFlight ?? 5),
    maxApiKeys: Number(doc.maxApiKeys),
    maxPdfUpload: Number(doc.maxPdfUpload),
    maxPdfMb: Number(doc.maxPdfMb),
    analyticsRetentionDays: Number(
      doc.analyticsRetentionDays ?? (doc as { retentionDays?: number }).retentionDays ?? 0,
    ),
    isAutoEmbed: Boolean(doc.isAutoEmbed),
    embedBadgeCustomizable: Boolean(doc.embedBadgeCustomizable),
    ragAnalyticsEnabled: Boolean(doc.ragAnalyticsEnabled),
    priceLabel: doc.priceLabel != null ? String(doc.priceLabel) : null,
    priceNote: doc.priceNote != null ? String(doc.priceNote) : null,
    taskAccess: normalizeTaskAccessFromDoc(doc),
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}

/** Load or refresh all plans from MongoDB into memory. */
export async function reloadPlanRegistry(): Promise<void> {
  const docs = (await PlanModel.find().sort({ sortOrder: 1, slug: 1 }).lean()) as PlanDoc[];

  const nextBySlug = new Map<string, PlanSnapshot>();
  const nextOrdered: PlanSnapshot[] = [];
  let nextDefault: string | null = null;

  for (const doc of docs) {
    const snap = planDocToSnapshot(doc);
    nextBySlug.set(snap.slug, snap);
    nextOrdered.push(snap);
    if (snap.isDefault) nextDefault = snap.slug;
  }

  bySlug = nextBySlug;
  ordered = nextOrdered;
  defaultSlug = nextDefault;
  registryLoaded = true;
}

export function isPlanRegistryLoaded(): boolean {
  return registryLoaded;
}

export function getPlansFromRegistry(): readonly PlanSnapshot[] {
  return ordered;
}

export function getPlanBySlugFromRegistry(slug: string): PlanSnapshot | undefined {
  return bySlug.get(slug.trim().toLowerCase());
}

export function getPlanByIdFromRegistry(id: string): PlanSnapshot | undefined {
  return ordered.find((p) => p.id === id);
}

export function getDefaultPlanFromRegistry(): PlanSnapshot | undefined {
  if (defaultSlug) return bySlug.get(defaultSlug);
  return ordered.find((p) => p.isDefault);
}

/** Assigned plan on the user, otherwise the default plan from the registry. */
export function resolvePlanForUser(planRef: unknown): PlanSnapshot | undefined {
  if (planRef != null) {
    const id =
      typeof planRef === "object" && planRef !== null && "_id" in planRef
        ? (planRef as { _id: Types.ObjectId })._id.toString()
        : String(planRef);
    if (mongoose.Types.ObjectId.isValid(id)) {
      const byId = getPlanByIdFromRegistry(id);
      if (byId) return byId;
    }
  }

  return getDefaultPlanFromRegistry();
}

export type UserPlanContext = {
  plan?: unknown;
  planExpiresAt?: Date | string | null;
};

export function isUserPlanExpired(ctx: UserPlanContext, now = Date.now()): boolean {
  if (!ctx.planExpiresAt) return false;
  const t = ctx.planExpiresAt instanceof Date ? ctx.planExpiresAt.getTime() : new Date(ctx.planExpiresAt).getTime();
  return Number.isFinite(t) && t <= now;
}

/** Effective plan for limits: expired non-default assignments fall back to the default plan. */
export function resolveEffectivePlanForUser(ctx: UserPlanContext): PlanSnapshot | undefined {
  const assigned = resolvePlanForUser(ctx.plan);
  const defaultPlan = getDefaultPlanFromRegistry();
  if (assigned?.isDefault) return assigned;
  if (isUserPlanExpired(ctx)) return defaultPlan;
  return assigned ?? defaultPlan;
}

// ponytail: assert self-check
function _planExpirySelfCheck(): void {
  const past = new Date("2020-01-01T00:00:00.000Z");
  const future = new Date("2099-01-01T00:00:00.000Z");
  const pro = ordered.find((p) => !p.isDefault);
  const def = getDefaultPlanFromRegistry();
  if (!pro || !def) return;
  const expiredCtx: UserPlanContext = { plan: pro.id, planExpiresAt: past };
  const activeCtx: UserPlanContext = { plan: pro.id, planExpiresAt: future };
  const defaultCtx: UserPlanContext = { plan: def.id, planExpiresAt: past };
  console.assert(isUserPlanExpired(expiredCtx), "past expiry should be expired");
  console.assert(!isUserPlanExpired(activeCtx), "future expiry should be active");
  console.assert(resolveEffectivePlanForUser(expiredCtx)?.slug === def.slug, "expired → default");
  console.assert(resolveEffectivePlanForUser(activeCtx)?.slug === pro.slug, "active → assigned");
  console.assert(resolveEffectivePlanForUser(defaultCtx)?.slug === def.slug, "default ignores expiry");
}
if (process.argv[1]?.includes("planRegistry")) _planExpirySelfCheck();
