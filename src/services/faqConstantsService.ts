import crypto from "node:crypto";

import mongoose from "mongoose";

import { ApiKeyModel } from "../models/ApiKey.js";
import {
  DEFAULT_APP_BADGE_LABEL,
  DEFAULT_EMBED_AI_DISCLAIMER,
  FaqConstantModel,
  MAX_EMBED_AI_DISCLAIMER_LEN,
  MAX_EMBED_APP_BADGE_LABEL_LEN,
  MAX_EMBED_ASSISTANT_DESCRIPTION_LEN,
  MAX_EMBED_ASSISTANT_GREETING_LEN,
  MAX_EMBED_ASSISTANT_NAME_LEN,
  MAX_EMBED_FURTHER_INFO_LABEL_LEN,
  MAX_EMBED_FURTHER_INFO_URL_LEN,
} from "../models/faqConstant.js";
import { UserModel } from "../models/User.js";
import { deletePublicFile, updatePublicFile } from "./publicFilesService.js";
import {
  assertAndNormalizeEmbedAllowedOrigins,
  buildEmbedFrameAncestors,
} from "../utils/embedAllowedOrigins.js";
import {
  planAllowsPublicEmbed,
  resolveEmbedAppBadgePolicy,
  type EmbedAppBadgePolicy,
} from "../utils/planAccess.js";
import { resolvePlanForUser } from "../services/planRegistry.js";
import { hashEmbedToken } from "../utils/embedTokenHash.js";
import { findFaqConstantByEmbedTokenQuery } from "../utils/embedTokenLookup.js";

function norm(s: string): string {
  return s.trim();
}

async function loadOrCreateDoc(userId: mongoose.Types.ObjectId, apiKeyId: mongoose.Types.ObjectId) {
  let doc = await FaqConstantModel.findOne({ userId, apiKeyId });
  if (!doc) {
    doc = new FaqConstantModel({ userId, apiKeyId, categories: [] });
  }
  return doc;
}

const EMBED_PLAN_REQUIRED = "EMBED_PLAN_REQUIRED";

async function assertUserPlanAllowsPublicEmbed(userId: mongoose.Types.ObjectId): Promise<void> {
  const u = await UserModel.findById(userId).select("plan").lean();
  const plan = u ? resolvePlanForUser(u.plan) : undefined;
  if (!plan || !planAllowsPublicEmbed(plan)) {
    throw new Error(EMBED_PLAN_REQUIRED);
  }
}

async function userPlanEligibleForPublicEmbed(userId: mongoose.Types.ObjectId): Promise<boolean> {
  const u = await UserModel.findById(userId).select("plan").lean();
  if (!u) return false;
  const plan = resolvePlanForUser(u.plan);
  return Boolean(plan && planAllowsPublicEmbed(plan));
}

async function getEmbedAppBadgePolicyForUser(userId: mongoose.Types.ObjectId): Promise<EmbedAppBadgePolicy> {
  const u = await UserModel.findById(userId).select("plan").lean();
  const plan = u ? resolvePlanForUser(u.plan) : null;
  return resolveEmbedAppBadgePolicy(plan ?? null);
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

type EmbedInfoLike = {
  assistantName?: string | null;
  assistantProfilePicture?: { fileId?: string | null; url?: string | null } | null;
  assistantDescription?: string | null;
  assistantGreeting?: string | null;
  embedColor?: string | null;
  aiDisclaimer?: string | null;
  furtherInfoLink?: { label?: string | null; url?: string | null } | null;
  appBadge?: { enabled?: boolean | null; label?: string | null } | null;
} | null | undefined;

export type FaqEmbedFurtherInfoLink = { label: string; url: string } | null;
export type FaqEmbedPublicAppBadge = { label: string } | null;

function appBadgeEnabledRaw(info: EmbedInfoLike): boolean {
  const ab = info?.appBadge;
  if (ab == null || typeof ab !== "object") return true;
  if (typeof ab.enabled === "boolean") return ab.enabled;
  return true;
}

function appBadgeLabelRaw(info: EmbedInfoLike): string | null {
  const ab = info?.appBadge;
  if (ab == null || typeof ab !== "object") return null;
  return nilStr(ab.label);
}

function resolveAppBadgeAndDisclaimer(
  info: EmbedInfoLike,
  policy: EmbedAppBadgePolicy,
): { appBadge: FaqEmbedPublicAppBadge; aiDisclaimer: string } {
  if (policy === "required") {
    return {
      appBadge: { label: DEFAULT_APP_BADGE_LABEL },
      aiDisclaimer: DEFAULT_EMBED_AI_DISCLAIMER,
    };
  }
  if (policy === "customizable") {
    if (!appBadgeEnabledRaw(info)) {
      return { appBadge: null, aiDisclaimer: DEFAULT_EMBED_AI_DISCLAIMER };
    }
    return {
      appBadge: { label: appBadgeLabelRaw(info) ?? DEFAULT_APP_BADGE_LABEL },
      aiDisclaimer: nilStr(info?.aiDisclaimer) ?? DEFAULT_EMBED_AI_DISCLAIMER,
    };
  }
  return {
    appBadge: null,
    aiDisclaimer: nilStr(info?.aiDisclaimer) ?? DEFAULT_EMBED_AI_DISCLAIMER,
  };
}

function validateFurtherInfoUrl(raw: string): string {
  const s = raw.trim();
  if (!s) throw new Error("furtherInfoLink.url is required when a link label is set.");
  let url: URL;
  try {
    url = new URL(s.includes("://") ? s : `https://${s}`);
  } catch {
    throw new Error("furtherInfoLink.url must be a valid http or https URL.");
  }
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:") {
    const h = url.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return url.href;
  }
  throw new Error("furtherInfoLink.url must use https, or http on localhost only.");
}

function parseFurtherInfoLink(info: EmbedInfoLike): FaqEmbedFurtherInfoLink {
  const link = info?.furtherInfoLink;
  const label = nilStr(link?.label);
  const url = nilStr(link?.url);
  if (!label && !url) return null;
  if (!label || !url) return null;
  return { label, url };
}

function nilStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

export function assistantProfileRelativePath(info: EmbedInfoLike): string | null {
  const pic = info?.assistantProfilePicture;
  const fileId = typeof pic?.fileId === "string" && pic.fileId.trim() !== "" ? pic.fileId.trim() : null;
  const directUrl = typeof pic?.url === "string" && pic.url.trim() !== "" ? pic.url.trim() : null;
  if (directUrl) return directUrl.startsWith("/") ? directUrl : `/${directUrl}`;
  if (fileId) return `/api/v1/files/${fileId}`;
  return null;
}

export type FaqEmbedBrandingFields = {
  assistantName: string | null;
  assistantDescription: string | null;
  assistantGreeting: string | null;
  embedColor: string | null;
  assistantProfileUrl: string | null;
  /** Resolved disclaimer text for the public widget (never empty). */
  aiDisclaimer: string;
  furtherInfoLink: FaqEmbedFurtherInfoLink;
  appBadge: FaqEmbedPublicAppBadge;
};

export function embedInfoToBrandingPayload(
  info: EmbedInfoLike,
  resolveFileUrl: (path: string | null) => string | null,
  policy: EmbedAppBadgePolicy,
): FaqEmbedBrandingFields {
  const rel = assistantProfileRelativePath(info);
  const { appBadge, aiDisclaimer } = resolveAppBadgeAndDisclaimer(info, policy);
  return {
    assistantName: nilStr(info?.assistantName),
    assistantDescription: nilStr(info?.assistantDescription),
    assistantGreeting: nilStr(info?.assistantGreeting),
    embedColor: nilStr(info?.embedColor),
    assistantProfileUrl: rel ? resolveFileUrl(rel) : null,
    aiDisclaimer,
    furtherInfoLink: parseFurtherInfoLink(info),
    appBadge,
  };
}

export type FaqEmbedFlags = {
  embedEnabled: boolean;
  hasToken: boolean;
  /** Account plan allows public embed (Pro / Scale). */
  embedPlanEligible: boolean;
  /** Third-party parent origins (empty = CSP `frame-ancestors` only `'self'`). */
  allowedOrigins: string[];
  /** Plaintext token for authenticated dashboard only; null when unset. */
  token: string | null;
  assistantName: string | null;
  assistantDescription: string | null;
  assistantGreeting: string | null;
  embedColor: string | null;
  assistantProfileUrl: string | null;
  /** Custom disclaimer override; null = widget uses {@link DEFAULT_EMBED_AI_DISCLAIMER}. */
  aiDisclaimer: string | null;
  furtherInfoLink: FaqEmbedFurtherInfoLink;
  embedAppBadgePolicy: EmbedAppBadgePolicy;
  /** Raw toggle; meaningful when policy is `customizable`. */
  appBadgeEnabled: boolean | null;
  appBadgeLabel: string | null;
  aiDisclaimerEditable: boolean;
};

export async function getFaqEmbedFlags(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  options?: { resolveFileUrl?: (path: string | null) => string | null },
): Promise<FaqEmbedFlags> {
  const resolve = options?.resolveFileUrl ?? ((p: string | null) => p);
  const doc = await FaqConstantModel.findOne({ userId, apiKeyId })
    .select("embedEnabled embedToken embedTokenHash embedAllowedOrigins embedInfo")
    .lean();
  const raw = Array.isArray(doc?.embedAllowedOrigins) ? doc.embedAllowedOrigins.map((x) => String(x)) : [];
  const allowedOrigins = [...new Set(raw.map((x) => x.trim()).filter(Boolean))];
  const hasHash = typeof doc?.embedTokenHash === "string" && doc.embedTokenHash.length > 0;
  const legacyToken =
    typeof doc?.embedToken === "string" && doc.embedToken.trim().length > 0 ? doc.embedToken.trim() : null;
  const token = legacyToken;
  const hasToken = hasHash || Boolean(legacyToken);
  const info = doc?.embedInfo;
  const policy = await getEmbedAppBadgePolicyForUser(userId);
  const branding = embedInfoToBrandingPayload(info, resolve, policy);
  const embedPlanEligible = await userPlanEligibleForPublicEmbed(userId);
  const badgeEnabled = appBadgeEnabledRaw(info);
  const disclaimerEditable = policy === "customizable" && badgeEnabled;
  return {
    embedEnabled: Boolean(doc?.embedEnabled),
    hasToken,
    embedPlanEligible,
    allowedOrigins,
    token,
    assistantName: branding.assistantName,
    assistantDescription: branding.assistantDescription,
    assistantGreeting: branding.assistantGreeting,
    embedColor: branding.embedColor,
    assistantProfileUrl: branding.assistantProfileUrl,
    aiDisclaimer: disclaimerEditable ? nilStr(info?.aiDisclaimer) : null,
    furtherInfoLink: branding.furtherInfoLink,
    embedAppBadgePolicy: policy,
    appBadgeEnabled: policy === "customizable" ? badgeEnabled : null,
    appBadgeLabel: policy === "customizable" ? appBadgeLabelRaw(info) : null,
    aiDisclaimerEditable: disclaimerEditable,
  };
}

export async function setEmbedEnabled(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  enabled: boolean,
  resolveFileUrl: (path: string | null) => string | null,
): Promise<FaqEmbedFlags> {
  if (enabled) {
    await assertUserPlanAllowsPublicEmbed(userId);
  }
  const doc = await loadOrCreateDoc(userId, apiKeyId);
  doc.set("embedEnabled", enabled);
  await doc.save();
  return getFaqEmbedFlags(userId, apiKeyId, { resolveFileUrl });
}

export async function setEmbedAllowedOrigins(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  raw: string[],
  resolveFileUrl: (path: string | null) => string | null,
): Promise<FaqEmbedFlags> {
  const normalized = assertAndNormalizeEmbedAllowedOrigins(raw);
  const doc = await loadOrCreateDoc(userId, apiKeyId);
  doc.set("embedAllowedOrigins", normalized);
  await doc.save();
  return getFaqEmbedFlags(userId, apiKeyId, { resolveFileUrl });
}

/** Generates a new plaintext embed token (replaces any previous token). */
export async function rotateEmbedToken(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  resolveFileUrl: (path: string | null) => string | null,
): Promise<{ token: string; flags: FaqEmbedFlags }> {
  await assertUserPlanAllowsPublicEmbed(userId);
  const raw = `et_${crypto.randomBytes(24).toString("hex")}`;
  const doc = await loadOrCreateDoc(userId, apiKeyId);
  doc.set("embedTokenHash", hashEmbedToken(raw));
  doc.set("embedToken", null);
  doc.set("embedTokenCreatedAt", new Date());
  await doc.save();
  const flags = await getFaqEmbedFlags(userId, apiKeyId, { resolveFileUrl });
  return { token: raw, flags };
}

export async function isEmbedTokenActive(rawToken: string): Promise<boolean> {
  const token = rawToken.trim();
  if (!token) return false;
  const doc = await FaqConstantModel.findOne({ embedToken: token, embedEnabled: true }).select("apiKeyId").lean();
  if (!doc?.apiKeyId) return false;
  const apiKey = await ApiKeyModel.findOne({ _id: doc.apiKeyId, revokedAt: null }).select("userId").lean();
  if (!apiKey?.userId) return false;
  const user = await UserModel.findById(apiKey.userId).select("plan isBlocked").lean();
  if (!user || user.isBlocked) return false;
  const plan = resolvePlanForUser(user.plan);
  return Boolean(plan && planAllowsPublicEmbed(plan));
}

/**
 * CSP `frame-ancestors` token list for an active embed token, or `null` if invalid/disabled.
 */
export async function getEmbedFrameAncestorsForRawToken(rawToken: string): Promise<string[] | null> {
  const token = rawToken.trim();
  if (!token) return null;
  if (!(await isEmbedTokenActive(token))) return null;
  const lookup = findFaqConstantByEmbedTokenQuery(token);
  if (!lookup) return null;
  const doc = await FaqConstantModel.findOne(lookup).select("embedAllowedOrigins").lean();
  if (!doc) return null;
  const originsRaw = Array.isArray(doc.embedAllowedOrigins) ? doc.embedAllowedOrigins.map((x) => String(x)) : [];
  const extras = [...new Set(originsRaw.map((x) => x.trim()).filter(Boolean))];
  return buildEmbedFrameAncestors(extras);
}

export type FaqEmbedUiPatch = {
  assistantName?: string | null;
  assistantDescription?: string | null;
  assistantGreeting?: string | null;
  embedColor?: string | null;
  aiDisclaimer?: string | null;
  furtherInfoLink?: { label: string | null; url: string | null } | null;
  appBadge?: { enabled: boolean; label: string | null } | null;
  clearAssistantAvatar?: boolean;
};

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function validateOptionalHexColor(v: string | null | undefined): void {
  if (v == null || v === "") return;
  if (!HEX_COLOR.test(v)) throw new Error("embedColor must be a hex color (#RGB, #RRGGBB, or #RRGGBBAA).");
}

export async function setFaqEmbedUiSettings(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  patch: FaqEmbedUiPatch,
  resolveFileUrl: (path: string | null) => string | null,
): Promise<FaqEmbedFlags> {
  const doc = await loadOrCreateDoc(userId, apiKeyId);
  const policy = await getEmbedAppBadgePolicyForUser(userId);

  if (patch.appBadge !== undefined || patch.aiDisclaimer !== undefined) {
    if (policy === "required") {
      const triesBadge = patch.appBadge !== undefined;
      const triesDisclaimer =
        patch.aiDisclaimer !== undefined && patch.aiDisclaimer !== null && patch.aiDisclaimer !== "";
      if (triesBadge || triesDisclaimer) {
        throw new Error("App badge and disclaimer cannot be customized on this plan.");
      }
    }
    if (policy !== "customizable" && patch.appBadge !== undefined) {
      throw new Error("App badge cannot be customized on this plan.");
    }
  }

  if (patch.assistantName !== undefined) {
    const v = patch.assistantName === null ? null : String(patch.assistantName).trim() || null;
    if (v && v.length > MAX_EMBED_ASSISTANT_NAME_LEN) {
      throw new Error(`assistantName must be at most ${MAX_EMBED_ASSISTANT_NAME_LEN} characters.`);
    }
    doc.set("embedInfo.assistantName", v);
  }
  if (patch.assistantDescription !== undefined) {
    const v = patch.assistantDescription === null ? null : String(patch.assistantDescription).trim() || null;
    if (v && v.length > MAX_EMBED_ASSISTANT_DESCRIPTION_LEN) {
      throw new Error(`assistantDescription must be at most ${MAX_EMBED_ASSISTANT_DESCRIPTION_LEN} characters.`);
    }
    doc.set("embedInfo.assistantDescription", v);
  }
  if (patch.assistantGreeting !== undefined) {
    const v = patch.assistantGreeting === null ? null : String(patch.assistantGreeting).trim() || null;
    if (v && v.length > MAX_EMBED_ASSISTANT_GREETING_LEN) {
      throw new Error(`assistantGreeting must be at most ${MAX_EMBED_ASSISTANT_GREETING_LEN} characters.`);
    }
    doc.set("embedInfo.assistantGreeting", v);
  }
  if (patch.embedColor !== undefined) {
    const v = patch.embedColor === null ? null : String(patch.embedColor).trim() || null;
    validateOptionalHexColor(v ?? undefined);
    doc.set("embedInfo.embedColor", v);
  }
  if (patch.appBadge !== undefined && policy === "customizable") {
    if (patch.appBadge === null) {
      doc.set("embedInfo.appBadge", { enabled: true, label: null });
    } else {
      const label =
        patch.appBadge.label === null ? null : String(patch.appBadge.label).trim() || null;
      if (label && label.length > MAX_EMBED_APP_BADGE_LABEL_LEN) {
        throw new Error(`appBadge.label must be at most ${MAX_EMBED_APP_BADGE_LABEL_LEN} characters.`);
      }
      doc.set("embedInfo.appBadge", { enabled: patch.appBadge.enabled, label });
      if (!patch.appBadge.enabled) {
        doc.set("embedInfo.aiDisclaimer", null);
      }
    }
  }

  if (patch.aiDisclaimer !== undefined) {
    if (policy !== "customizable") {
      throw new Error("AI disclaimer cannot be customized on this plan.");
    }
    const badgeOn =
      patch.appBadge !== undefined && patch.appBadge !== null
        ? patch.appBadge.enabled
        : appBadgeEnabledRaw(doc.get("embedInfo") as EmbedInfoLike);
    const v = patch.aiDisclaimer === null ? null : String(patch.aiDisclaimer).trim() || null;
    if (v && !badgeOn) {
      throw new Error("Custom disclaimer requires the app badge to be enabled.");
    }
    if (v && v.length > MAX_EMBED_AI_DISCLAIMER_LEN) {
      throw new Error(`aiDisclaimer must be at most ${MAX_EMBED_AI_DISCLAIMER_LEN} characters.`);
    }
    doc.set("embedInfo.aiDisclaimer", v);
  }
  if (patch.furtherInfoLink !== undefined) {
    if (patch.furtherInfoLink === null) {
      doc.set("embedInfo.furtherInfoLink", { label: null, url: null });
    } else {
      const labelRaw =
        patch.furtherInfoLink.label === null ? null : String(patch.furtherInfoLink.label).trim() || null;
      const urlRaw = patch.furtherInfoLink.url === null ? null : String(patch.furtherInfoLink.url).trim() || null;
      if (!labelRaw && !urlRaw) {
        doc.set("embedInfo.furtherInfoLink", { label: null, url: null });
      } else {
        if (!labelRaw || !urlRaw) {
          throw new Error("furtherInfoLink requires both label and url, or clear both.");
        }
        if (labelRaw.length > MAX_EMBED_FURTHER_INFO_LABEL_LEN) {
          throw new Error(`furtherInfoLink.label must be at most ${MAX_EMBED_FURTHER_INFO_LABEL_LEN} characters.`);
        }
        const normalizedUrl = validateFurtherInfoUrl(urlRaw);
        if (normalizedUrl.length > MAX_EMBED_FURTHER_INFO_URL_LEN) {
          throw new Error(`furtherInfoLink.url must be at most ${MAX_EMBED_FURTHER_INFO_URL_LEN} characters.`);
        }
        doc.set("embedInfo.furtherInfoLink", { label: labelRaw, url: normalizedUrl });
      }
    }
  }

  if (patch.clearAssistantAvatar === true) {
    const ei = doc.get("embedInfo") as
      | { assistantProfilePicture?: { fileId?: string | null } | null }
      | undefined;
    const prevId =
      typeof ei?.assistantProfilePicture?.fileId === "string" && ei.assistantProfilePicture.fileId.trim() !== ""
        ? ei.assistantProfilePicture.fileId.trim()
        : null;
    doc.set("embedInfo.assistantProfilePicture", { fileId: null, url: null });
    if (prevId) {
      await deletePublicFile(prevId).catch(() => undefined);
    }
  }

  await doc.save();
  return getFaqEmbedFlags(userId, apiKeyId, { resolveFileUrl });
}

export async function replaceFaqEmbedAssistantPicture(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  file: { buffer: Buffer; filename: string; mimetype: string },
  resolveFileUrl: (path: string | null) => string | null,
): Promise<FaqEmbedFlags> {
  const doc = await loadOrCreateDoc(userId, apiKeyId);
  const ei = doc.get("embedInfo") as
    | { assistantProfilePicture?: { fileId?: string | null } | null }
    | undefined;
  const prevId =
    typeof ei?.assistantProfilePicture?.fileId === "string" && ei.assistantProfilePicture.fileId.trim() !== ""
      ? ei.assistantProfilePicture.fileId.trim()
      : null;
  const uploaded = await updatePublicFile(prevId, file.buffer, {
    originalFilename: file.filename || "assistant-avatar",
    contentType: file.mimetype || "application/octet-stream",
  });
  doc.set("embedInfo.assistantProfilePicture", { fileId: uploaded.fileId, url: uploaded.urlPath });
  await doc.save();
  return getFaqEmbedFlags(userId, apiKeyId, { resolveFileUrl });
}

export async function getPublicEmbedBrandingForActiveToken(
  rawToken: string,
  resolveFileUrl: (path: string | null) => string | null,
): Promise<FaqEmbedBrandingFields | null> {
  const token = rawToken.trim();
  if (!token) return null;
  const lookup = findFaqConstantByEmbedTokenQuery(token);
  if (!lookup) return null;
  const doc = await FaqConstantModel.findOne(lookup).select("embedInfo apiKeyId").lean();
  if (!doc?.apiKeyId) return null;
  const apiKey = await ApiKeyModel.findOne({ _id: doc.apiKeyId, revokedAt: null }).select("userId").lean();
  if (!apiKey?.userId) return null;
  const user = await UserModel.findById(apiKey.userId).select("plan isBlocked").lean();
  if (!user || user.isBlocked) return null;
  const plan = resolvePlanForUser(user.plan);
  if (!plan || !planAllowsPublicEmbed(plan)) return null;
  const policy = resolveEmbedAppBadgePolicy(plan);
  return embedInfoToBrandingPayload(doc.embedInfo, resolveFileUrl, policy);
}
