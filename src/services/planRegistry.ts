import mongoose, { type Types } from "mongoose";

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
  maxApiKeys: number;
  maxPdfUpload: number;
  maxPdfMb: number;
  analyticsRetentionDays: number;
  isAutoEmbed: boolean;
  embedBadgeCustomizable: boolean;
  ragAnalyticsEnabled: boolean;
  priceLabel: string | null;
  priceNote: string | null;
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
