import mongoose from "mongoose";

import { PlanModel } from "../models/Plan.js";
import { UserModel } from "../models/User.js";
import {
  getPlanByIdFromRegistry,
  getPlansFromRegistry,
  isPlanRegistryLoaded,
  planDocToSnapshot,
  reloadPlanRegistry,
  type PlanSnapshot,
} from "./planRegistry.js";
import type { PlanCreateBody, PlanPatchBody } from "../validation/planSchemas.js";

async function clearOtherDefaults(exceptId?: string): Promise<void> {
  const filter: Record<string, unknown> = { isDefault: true };
  if (exceptId && mongoose.Types.ObjectId.isValid(exceptId)) {
    filter._id = { $ne: new mongoose.Types.ObjectId(exceptId) };
  }
  await PlanModel.updateMany(filter, { $set: { isDefault: false } });
}

function normalizeOptionalPrice(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const t = value.trim();
  return t === "" ? null : t;
}

export async function listPlans(): Promise<PlanSnapshot[]> {
  if (!isPlanRegistryLoaded()) await reloadPlanRegistry();
  return [...getPlansFromRegistry()];
}

export async function getPlanById(id: string): Promise<PlanSnapshot | null> {
  if (!isPlanRegistryLoaded()) await reloadPlanRegistry();
  const cached = getPlanByIdFromRegistry(id);
  if (cached) return cached;

  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const doc = await PlanModel.findById(id).lean();
  if (!doc) return null;
  return planDocToSnapshot(doc as Parameters<typeof planDocToSnapshot>[0]);
}

export async function createPlan(input: PlanCreateBody): Promise<PlanSnapshot> {
  const existing = await PlanModel.findOne({ slug: input.slug }).lean();
  if (existing) {
    throw new Error("A plan with this slug already exists.");
  }

  if (input.isDefault) await clearOtherDefaults();

  const doc = await PlanModel.create({
    slug: input.slug,
    name: input.name,
    description: input.description ?? "",
    isActive: input.isActive ?? true,
    sortOrder: input.sortOrder ?? 0,
    isDefault: input.isDefault ?? false,
    isPriority: input.isPriority ?? false,
    rateLimitPerMinute: input.rateLimitPerMinute,
    maxCharacterPerMessage: input.maxCharacterPerMessage,
    maxChatInFlight: input.maxChatInFlight,
    maxApiKeys: input.maxApiKeys,
    maxPdfUpload: input.maxPdfUpload,
    maxPdfMb: input.maxPdfMb,
    analyticsRetentionDays: input.analyticsRetentionDays,
    isAutoEmbed: input.isAutoEmbed ?? false,
    embedBadgeCustomizable: input.embedBadgeCustomizable ?? false,
    ragAnalyticsEnabled: input.ragAnalyticsEnabled ?? false,
    priceLabel: normalizeOptionalPrice(input.priceLabel) ?? null,
    priceNote: normalizeOptionalPrice(input.priceNote) ?? null,
    taskAccess: input.taskAccess,
  });

  await reloadPlanRegistry();
  return planDocToSnapshot(doc);
}

export async function updatePlan(id: string, input: PlanPatchBody): Promise<PlanSnapshot> {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new Error("Invalid plan id.");
  }

  const doc = await PlanModel.findById(id);
  if (!doc) throw new Error("Plan not found.");

  if (input.name !== undefined) doc.name = input.name;
  if (input.description !== undefined) doc.description = input.description;
  if (input.isActive !== undefined) doc.isActive = input.isActive;
  if (input.sortOrder !== undefined) doc.sortOrder = input.sortOrder;
  if (input.isPriority !== undefined) doc.isPriority = input.isPriority;
  if (input.rateLimitPerMinute !== undefined) doc.rateLimitPerMinute = input.rateLimitPerMinute;
  if (input.maxCharacterPerMessage !== undefined) {
    doc.maxCharacterPerMessage = input.maxCharacterPerMessage;
  }
  if (input.maxChatInFlight !== undefined) doc.maxChatInFlight = input.maxChatInFlight;
  if (input.maxApiKeys !== undefined) doc.maxApiKeys = input.maxApiKeys;
  if (input.maxPdfUpload !== undefined) doc.maxPdfUpload = input.maxPdfUpload;
  if (input.maxPdfMb !== undefined) doc.maxPdfMb = input.maxPdfMb;
  if (input.analyticsRetentionDays !== undefined) {
    doc.analyticsRetentionDays = input.analyticsRetentionDays;
  }
  if (input.isAutoEmbed !== undefined) doc.isAutoEmbed = input.isAutoEmbed;
  if (input.embedBadgeCustomizable !== undefined) {
    doc.embedBadgeCustomizable = input.embedBadgeCustomizable;
  }
  if (input.ragAnalyticsEnabled !== undefined) doc.ragAnalyticsEnabled = input.ragAnalyticsEnabled;
  if (input.priceLabel !== undefined) doc.priceLabel = normalizeOptionalPrice(input.priceLabel);
  if (input.priceNote !== undefined) doc.priceNote = normalizeOptionalPrice(input.priceNote);
  if (input.taskAccess !== undefined) doc.taskAccess = input.taskAccess;

  if (input.isDefault === true) {
    await clearOtherDefaults(id);
    doc.isDefault = true;
  } else if (input.isDefault === false) {
    doc.isDefault = false;
  }

  await doc.save();
  await reloadPlanRegistry();
  return getPlanByIdFromRegistry(id) ?? planDocToSnapshot(doc);
}

export async function deletePlan(id: string): Promise<void> {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new Error("Invalid plan id.");
  }

  const doc = await PlanModel.findById(id).lean();
  if (!doc) throw new Error("Plan not found.");

  const slug = String(doc.slug);
  const userCount = await UserModel.countDocuments({ plan: doc._id });
  if (userCount > 0) {
    throw new Error(`Cannot delete plan "${slug}": ${userCount} user(s) still assigned to it.`);
  }

  if (doc.isDefault) {
    throw new Error("Cannot delete the default plan. Set another plan as default first.");
  }

  await PlanModel.deleteOne({ _id: doc._id });
  await reloadPlanRegistry();
}
