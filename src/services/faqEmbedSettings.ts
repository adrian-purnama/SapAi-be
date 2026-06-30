import crypto from "node:crypto";

import mongoose from "mongoose";

import { ApiKeyModel } from "../models/ApiKey.js";
import {
  MAX_EMBED_AI_DISCLAIMER_LEN,
  MAX_EMBED_APP_BADGE_LABEL_LEN,
  MAX_EMBED_ASSISTANT_DESCRIPTION_LEN,
  MAX_EMBED_ASSISTANT_GREETING_LEN,
  MAX_EMBED_ASSISTANT_NAME_LEN,
  MAX_EMBED_FURTHER_INFO_LABEL_LEN,
  MAX_EMBED_FURTHER_INFO_URL_LEN,
  MAX_EMBED_RAG_GUARDRAILS_LEN,
  MAX_EMBED_RAG_TONE_LEN,
  FaqConstantModel,
} from "../models/faqConstant.js";
import { UserModel } from "../models/User.js";
import {
  assertAndNormalizeEmbedAllowedOrigins,
  buildEmbedFrameAncestors,
} from "../utils/embedAllowedOrigins.js";
import {
  resolveEmbedAppBadgePolicy,
  type EmbedAppBadgePolicy,
} from "../utils/planAccess.js";
import { resolveEffectivePlanForUser, type PlanSnapshot } from "../services/planRegistry.js";
import { findFaqConstantByEmbedTokenQuery } from "../utils/embedTokenLookup.js";
import { deletePublicFile, updatePublicFile } from "./publicFilesService.js";
import {
  appBadgeEnabledRaw,
  appBadgeLabelRaw,
  assertUserPlanAllowsPublicEmbed,
  embedInfoToBrandingPayload,
  getEmbedAppBadgePolicyForUser,
  loadOrCreateDoc,
  nilStr,
  userPlanEligibleForPublicEmbed,
  validateFurtherInfoUrl,
  validateOptionalHexColor,
  type EmbedInfoLike,
  type FaqEmbedBrandingFields,
  type FaqEmbedFurtherInfoLink,
} from "./faqConstantsCore.js";

export type { FaqEmbedBrandingFields } from "./faqConstantsCore.js";

export type ActiveEmbedContext = {
  token: string;
  apiKeyId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  plan: PlanSnapshot;
  faqDoc: Record<string, unknown>;
};

/** FaqConstant → ApiKey → userId (no plan gate). */
export async function resolveEmbedTokenChain(
  rawToken: string,
  faqSelect: string,
): Promise<Omit<ActiveEmbedContext, "plan"> | null> {
  const token = rawToken.trim();
  if (!token) return null;
  const lookup = findFaqConstantByEmbedTokenQuery(token);
  if (!lookup) return null;
  const select = faqSelect.includes("apiKeyId") ? faqSelect : `apiKeyId ${faqSelect}`;
  const doc = await FaqConstantModel.findOne(lookup).select(select).lean();
  if (!doc?.apiKeyId) return null;
  const apiKey = await ApiKeyModel.findOne({ _id: doc.apiKeyId, revokedAt: null }).select("userId").lean();
  if (!apiKey?.userId) return null;
  return {
    token,
    apiKeyId: doc.apiKeyId as mongoose.Types.ObjectId,
    userId: apiKey.userId as mongoose.Types.ObjectId,
    faqDoc: doc as Record<string, unknown>,
  };
}

/** Active embed token with plan eligibility (`isAutoEmbed`, user not blocked). */
export async function resolveActiveEmbedContext(
  rawToken: string,
  faqSelect = "apiKeyId",
): Promise<ActiveEmbedContext | null> {
  const chain = await resolveEmbedTokenChain(rawToken, faqSelect);
  if (!chain) return null;
  const user = await UserModel.findById(chain.userId).select("plan planExpiresAt isBlocked").lean();
  if (!user || user.isBlocked) return null;
  const plan = resolveEffectivePlanForUser(user);
  if (!plan?.isAutoEmbed) return null;
  return { ...chain, plan };
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
  /** RAG tone override (Scale only); null when not editable. */
  ragTone: string | null;
  /** RAG guardrails override (Scale only); null when not editable. */
  ragGuardrails: string | null;
  ragPromptEditable: boolean;
};

export async function getFaqEmbedFlags(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  options?: { resolveFileUrl?: (path: string | null) => string | null },
): Promise<FaqEmbedFlags> {
  const resolve = options?.resolveFileUrl ?? ((p: string | null) => p);
  const doc = await FaqConstantModel.findOne({ userId, apiKeyId })
    .select("embedEnabled embedToken embedAllowedOrigins embedInfo")
    .lean();
  const raw = Array.isArray(doc?.embedAllowedOrigins) ? doc.embedAllowedOrigins.map((x) => String(x)) : [];
  const allowedOrigins = [...new Set(raw.map((x) => x.trim()).filter(Boolean))];
  const token =
    typeof doc?.embedToken === "string" && doc.embedToken.trim().length > 0 ? doc.embedToken.trim() : null;
  const hasToken = Boolean(token);
  const info = doc?.embedInfo;
  const policy = await getEmbedAppBadgePolicyForUser(userId);
  const branding = embedInfoToBrandingPayload(info, resolve, policy);
  const embedPlanEligible = await userPlanEligibleForPublicEmbed(userId);
  const badgeEnabled = appBadgeEnabledRaw(info);
  const disclaimerEditable = policy === "customizable" && badgeEnabled;
  const ragPromptEditable = policy === "customizable";
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
    ragTone: ragPromptEditable ? nilStr(info?.ragTone) : null,
    ragGuardrails: ragPromptEditable ? nilStr(info?.ragGuardrails) : null,
    ragPromptEditable,
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
  doc.set("embedToken", raw);
  doc.set("embedTokenCreatedAt", new Date());
  await doc.save();
  const flags = await getFaqEmbedFlags(userId, apiKeyId, { resolveFileUrl });
  return { token: raw, flags };
}

export async function isEmbedTokenActive(rawToken: string): Promise<boolean> {
  return (await resolveActiveEmbedContext(rawToken)) !== null;
}

/**
 * CSP `frame-ancestors` token list for an active embed token, or `null` if invalid/disabled.
 */
export async function getEmbedFrameAncestorsForRawToken(rawToken: string): Promise<string[] | null> {
  const ctx = await resolveActiveEmbedContext(rawToken, "embedAllowedOrigins");
  if (!ctx) return null;
  const originsRaw = Array.isArray(ctx.faqDoc.embedAllowedOrigins)
    ? ctx.faqDoc.embedAllowedOrigins.map((x) => String(x))
    : [];
  const extras = [...new Set(originsRaw.map((x) => x.trim()).filter(Boolean))];
  return buildEmbedFrameAncestors(extras);
}

export async function getPublicEmbedBrandingForActiveToken(
  rawToken: string,
  resolveFileUrl: (path: string | null) => string | null,
): Promise<FaqEmbedBrandingFields | null> {
  const ctx = await resolveActiveEmbedContext(rawToken, "embedInfo apiKeyId");
  if (!ctx) return null;
  const policy = resolveEmbedAppBadgePolicy(ctx.plan);
  return embedInfoToBrandingPayload(ctx.faqDoc.embedInfo as EmbedInfoLike, resolveFileUrl, policy);
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

export type FaqEmbedUiPatch = {
  assistantName?: string | null;
  assistantDescription?: string | null;
  assistantGreeting?: string | null;
  embedColor?: string | null;
  aiDisclaimer?: string | null;
  furtherInfoLink?: { label: string | null; url: string | null } | null;
  appBadge?: { enabled: boolean; label: string | null } | null;
  clearAssistantAvatar?: boolean;
  ragTone?: string | null;
  ragGuardrails?: string | null;
};

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

  if (patch.ragTone !== undefined || patch.ragGuardrails !== undefined) {
    const triesRagTone =
      patch.ragTone !== undefined && patch.ragTone !== null && String(patch.ragTone).trim() !== "";
    const triesRagGuardrails =
      patch.ragGuardrails !== undefined &&
      patch.ragGuardrails !== null &&
      String(patch.ragGuardrails).trim() !== "";
    if (policy !== "customizable" && (triesRagTone || triesRagGuardrails)) {
      throw new Error("RAG tone and guardrails cannot be customized on this plan.");
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
  if (patch.ragTone !== undefined && policy === "customizable") {
    const v = patch.ragTone === null ? null : String(patch.ragTone).trim() || null;
    if (v && v.length > MAX_EMBED_RAG_TONE_LEN) {
      throw new Error(`ragTone must be at most ${MAX_EMBED_RAG_TONE_LEN} characters.`);
    }
    doc.set("embedInfo.ragTone", v);
  }
  if (patch.ragGuardrails !== undefined && policy === "customizable") {
    const v = patch.ragGuardrails === null ? null : String(patch.ragGuardrails).trim() || null;
    if (v && v.length > MAX_EMBED_RAG_GUARDRAILS_LEN) {
      throw new Error(`ragGuardrails must be at most ${MAX_EMBED_RAG_GUARDRAILS_LEN} characters.`);
    }
    doc.set("embedInfo.ragGuardrails", v);
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
