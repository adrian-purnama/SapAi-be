import mongoose from "mongoose";

import { FaqConstantModel } from "../models/faqConstant.js";
import { loadOrCreateDoc } from "./faqConstantsCore.js";

export * from "./faqEmbedSettings.js";
export * from "./faqBranding.js";

function norm(s: string): string {
  return s.trim();
}

export async function getFaqConstantCategories(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
): Promise<string[]> {
  const doc = await FaqConstantModel.findOne({ userId, apiKeyId }).lean();
  return Array.isArray(doc?.categories) ? [...doc.categories] : [];
}

export async function setFaqConstantCategories(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  categories: string[],
): Promise<string[]> {
  const doc = await loadOrCreateDoc(userId, apiKeyId);
  doc.categories = categories;
  await doc.save();
  return Array.isArray(doc.categories) ? [...doc.categories] : [];
}

export async function addFaqConstantCategories(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  values: string[],
): Promise<string[]> {
  const doc = await loadOrCreateDoc(userId, apiKeyId);
  const existing = Array.isArray(doc.categories) ? [...doc.categories] : [];
  doc.categories = [...existing, ...values];
  await doc.save();
  return Array.isArray(doc.categories) ? [...doc.categories] : [];
}

export async function removeFaqConstantCategories(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  values: string[],
): Promise<string[]> {
  const doc = await FaqConstantModel.findOne({ userId, apiKeyId });
  if (!doc) return [];
  const removeSet = new Set(values.map(norm).filter(Boolean));
  if (removeSet.size === 0) {
    return Array.isArray(doc.categories) ? [...doc.categories] : [];
  }
  const raw = Array.isArray(doc.categories) ? doc.categories : [];
  doc.categories = raw.filter((c) => !removeSet.has(norm(String(c))));
  await doc.save();
  return Array.isArray(doc.categories) ? [...doc.categories] : [];
}
