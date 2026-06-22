import mongoose from "mongoose";

import { ApiKeyModel } from "../models/ApiKey.js";
import { FaqConstantModel } from "../models/faqConstant.js";
import { UserModel } from "../models/User.js";
import { resolveEmbedAppBadgePolicy } from "../utils/planAccess.js";
import { resolveEffectivePlanForUser } from "../services/planRegistry.js";
import { findFaqConstantByEmbedTokenQuery } from "../utils/embedTokenLookup.js";
import { updatePublicFile } from "./publicFilesService.js";
import {
  embedInfoToBrandingPayload,
  loadOrCreateDoc,
  type FaqEmbedBrandingFields,
} from "./faqConstantsCore.js";
import { getFaqEmbedFlags, type FaqEmbedFlags } from "./faqEmbedSettings.js";

export type { FaqEmbedBrandingFields } from "./faqConstantsCore.js";

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
  const user = await UserModel.findById(apiKey.userId).select("plan planExpiresAt isBlocked").lean();
  if (!user || user.isBlocked) return null;
  const plan = resolveEffectivePlanForUser(user);
  if (!plan?.isAutoEmbed) return null;
  const policy = resolveEmbedAppBadgePolicy(plan);
  return embedInfoToBrandingPayload(doc.embedInfo, resolveFileUrl, policy);
}
