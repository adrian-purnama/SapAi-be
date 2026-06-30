import mongoose from "mongoose";

import {
  DEFAULT_APP_BADGE_LABEL,
  DEFAULT_EMBED_AI_DISCLAIMER,
  FaqConstantModel,
} from "../models/faqConstant.js";
import { DEFAULT_CHAT_SYSTEM_GUARDRAILS } from "../constants/chatSystemGuardrails.js";
import { resolveEmbedAppBadgePolicy, type EmbedAppBadgePolicy } from "../utils/planAccess.js";
import { getEffectivePlanForUserId } from "../services/planRegistry.js";

export async function loadOrCreateDoc(userId: mongoose.Types.ObjectId, apiKeyId: mongoose.Types.ObjectId) {
  let doc = await FaqConstantModel.findOne({ userId, apiKeyId });
  if (!doc) {
    doc = new FaqConstantModel({ userId, apiKeyId, categories: [] });
  }
  return doc;
}

export const EMBED_PLAN_REQUIRED = "EMBED_PLAN_REQUIRED";

export async function assertUserPlanAllowsPublicEmbed(userId: mongoose.Types.ObjectId): Promise<void> {
  const plan = await getEffectivePlanForUserId(userId);
  if (!plan?.isAutoEmbed) {
    throw new Error(EMBED_PLAN_REQUIRED);
  }
}

export async function userPlanEligibleForPublicEmbed(userId: mongoose.Types.ObjectId): Promise<boolean> {
  const plan = await getEffectivePlanForUserId(userId);
  return Boolean(plan?.isAutoEmbed);
}

export async function getEmbedAppBadgePolicyForUser(userId: mongoose.Types.ObjectId): Promise<EmbedAppBadgePolicy> {
  const plan = await getEffectivePlanForUserId(userId);
  return resolveEmbedAppBadgePolicy(plan);
}

export type EmbedInfoLike = {
  assistantName?: string | null;
  assistantProfilePicture?: { fileId?: string | null; url?: string | null } | null;
  assistantDescription?: string | null;
  assistantGreeting?: string | null;
  embedColor?: string | null;
  aiDisclaimer?: string | null;
  furtherInfoLink?: { label?: string | null; url?: string | null } | null;
  appBadge?: { enabled?: boolean | null; label?: string | null } | null;
  ragTone?: string | null;
  ragGuardrails?: string | null;
} | null | undefined;

export type FaqEmbedFurtherInfoLink = { label: string; url: string } | null;
export type FaqEmbedPublicAppBadge = { label: string } | null;

export function appBadgeEnabledRaw(info: EmbedInfoLike): boolean {
  const ab = info?.appBadge;
  if (ab == null || typeof ab !== "object") return true;
  if (typeof ab.enabled === "boolean") return ab.enabled;
  return true;
}

export function appBadgeLabelRaw(info: EmbedInfoLike): string | null {
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

export function validateFurtherInfoUrl(raw: string): string {
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

export function nilStr(v: unknown): string | null {
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

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function validateOptionalHexColor(v: string | null | undefined): void {
  if (v == null || v === "") return;
  if (!HEX_COLOR.test(v)) throw new Error("embedColor must be a hex color (#RGB, #RRGGBB, or #RRGGBBAA).");
}

export type RagSystemLayers = {
  guardrails: string;
  tone: string | null;
};

/** RAG-only system layers; ignores stored custom text when plan is not embedBadgeCustomizable. */
export async function resolveRagSystemLayers(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
): Promise<RagSystemLayers> {
  const plan = await getEffectivePlanForUserId(userId);
  const policy = resolveEmbedAppBadgePolicy(plan);
  if (policy !== "customizable") {
    return { guardrails: DEFAULT_CHAT_SYSTEM_GUARDRAILS, tone: null };
  }
  const doc = await FaqConstantModel.findOne({ userId, apiKeyId }).select("embedInfo").lean();
  const info = doc?.embedInfo as EmbedInfoLike;
  const guardrails = nilStr(info?.ragGuardrails) ?? DEFAULT_CHAT_SYSTEM_GUARDRAILS;
  const tone = nilStr(info?.ragTone);
  return { guardrails, tone };
}
