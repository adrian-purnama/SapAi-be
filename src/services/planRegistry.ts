import mongoose, { type Types } from "mongoose";

import { DEFAULT_TASK_ACCESS } from "../constants/taskCatalog.js";
import { PlanModel, type PlanLean } from "../models/Plan.js";
import { UserModel } from "../models/User.js";
import { toIso } from "../utils/chatJobMappers.js";

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
  maxOcrMb: number;
  analyticsRetentionDays: number;
  isAutoEmbed: boolean;
  embedBadgeCustomizable: boolean;
  ragAnalyticsEnabled: boolean;
  allowMcp: boolean;
  priceLabel: string | null;
  priceNote: string | null;
  showOnPricingPage: boolean;
  imageFileId: string | null;
  accentColor: string | null;
  midtrans: { grossAmount: number | null };
  taskAccess: Record<string, string[]>;
  createdAt: string | null;
  updatedAt: string | null;
};

type PlanDoc = PlanLean & { _id: Types.ObjectId };

let bySlug = new Map<string, PlanSnapshot>();
let ordered: PlanSnapshot[] = [];
let defaultSlug: string | null = null;
let registryLoaded = false;

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

function normalizeMidtransFromDoc(doc: PlanDoc): { grossAmount: number | null } {
  const raw = (doc as { midtrans?: { grossAmount?: unknown } }).midtrans;
  const n = raw?.grossAmount;
  if (n == null || n === "") return { grossAmount: null };
  const amount = Number(n);
  return {
    grossAmount: Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : null,
  };
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
    maxOcrMb: Number((doc as { maxOcrMb?: number }).maxOcrMb ?? 10),
    analyticsRetentionDays: Number(
      doc.analyticsRetentionDays ?? (doc as { retentionDays?: number }).retentionDays ?? 0,
    ),
    isAutoEmbed: Boolean(doc.isAutoEmbed),
    embedBadgeCustomizable: Boolean(doc.embedBadgeCustomizable),
    ragAnalyticsEnabled: Boolean(doc.ragAnalyticsEnabled),
    allowMcp: Boolean(doc.allowMcp),
    priceLabel: doc.priceLabel != null ? String(doc.priceLabel) : null,
    priceNote: doc.priceNote != null ? String(doc.priceNote) : null,
    showOnPricingPage: Boolean((doc as { showOnPricingPage?: boolean }).showOnPricingPage),
    imageFileId:
      (doc as { imageFileId?: string | null }).imageFileId?.trim() || null,
    accentColor: (doc as { accentColor?: string | null }).accentColor?.trim() || null,
    midtrans: normalizeMidtransFromDoc(doc),
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

export async function getEffectivePlanForUserId(
  userId: mongoose.Types.ObjectId | string,
): Promise<PlanSnapshot | null> {
  const user = await UserModel.findById(userId).select("plan planExpiresAt").lean();
  if (!user) return null;
  return resolveEffectivePlanForUser(user) ?? null;
}
