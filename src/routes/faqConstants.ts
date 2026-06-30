import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireBearerUser } from "../auth/requireBearerUser.js";
import {
  addFaqConstantCategories,
  getFaqConstantCategories,
  getFaqEmbedFlags,
  removeFaqConstantCategories,
  replaceFaqEmbedAssistantPicture,
  rotateEmbedToken,
  setEmbedAllowedOrigins,
  setEmbedEnabled,
  setFaqConstantCategories,
  setFaqEmbedUiSettings,
} from "../services/faqConstantsService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { isAllowedPublicImageMime, MAX_PUBLIC_IMAGE_BYTES } from "../utils/publicImageUpload.js";
import { toAbsoluteUrlFromRequest } from "../utils/publicOriginFromRequest.js";
import { requireActiveOwnedApiKey } from "../utils/requireOwnedApiKey.js";

function mapOwnedApiKeyGate(reply: Parameters<typeof sendError>[0], gate: { ok: false; error: string; status: number }) {
  const code =
    gate.status === 403 ? "API_KEY_DISABLED" : gate.status === 400 ? "INVALID_ID" : "NOT_FOUND";
  return sendError(reply, gate.error, gate.status, code);
}

const categoriesBodySchema = z.object({
  categories: z.array(z.string()),
});

const embedPatchBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    rotate: z.boolean().optional(),
    allowedOrigins: z.array(z.string()).optional(),
  })
  .refine((v) => v.enabled !== undefined || v.rotate === true || v.allowedOrigins !== undefined, {
    message: "Provide enabled, rotate: true, and/or allowedOrigins.",
  });

const hexEmbedColor = z.union([
  z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/),
  z.null(),
]);

const furtherInfoLinkPatchSchema = z.union([
  z.null(),
  z.object({
    label: z.union([z.string().max(80), z.null()]),
    url: z.union([z.string().max(2048), z.null()]),
  }),
]);

const appBadgePatchSchema = z.union([
  z.null(),
  z.object({
    enabled: z.boolean(),
    label: z.union([z.string().max(80), z.null()]),
  }),
]);

const embedUiPatchBodySchema = z
  .object({
    assistantName: z.union([z.string().max(80), z.null()]).optional(),
    assistantDescription: z.union([z.string().max(2000), z.null()]).optional(),
    assistantGreeting: z.union([z.string().max(1000), z.null()]).optional(),
    embedColor: hexEmbedColor.optional(),
    aiDisclaimer: z.union([z.string().max(500), z.null()]).optional(),
    furtherInfoLink: furtherInfoLinkPatchSchema.optional(),
    appBadge: appBadgePatchSchema.optional(),
    clearAssistantAvatar: z.boolean().optional(),
    ragTone: z.union([z.string().max(1000), z.null()]).optional(),
    ragGuardrails: z.union([z.string().max(2000), z.null()]).optional(),
  })
  .refine(
    (v) =>
      v.assistantName !== undefined ||
      v.assistantDescription !== undefined ||
      v.assistantGreeting !== undefined ||
      v.embedColor !== undefined ||
      v.aiDisclaimer !== undefined ||
      v.furtherInfoLink !== undefined ||
      v.appBadge !== undefined ||
      v.clearAssistantAvatar === true ||
      v.ragTone !== undefined ||
      v.ragGuardrails !== undefined,
    { message: "Provide at least one embed UI field to update." },
  );

const valuesBodySchema = z.object({
  values: z.array(z.string()).min(1, "Provide at least one value."),
});

export async function registerFaqConstantRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/api/v1/api-keys/:id/faq-constants",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      const user = request.bearerUser!;
      const id = String((request.params as { id?: string })?.id ?? "");
      const gate = await requireActiveOwnedApiKey(user._id, id);
      if (!gate.ok) {
        return mapOwnedApiKeyGate(reply, gate);
      }
      try {
        const categories = await getFaqConstantCategories(user._id, gate.apiKeyOid);
        const resolveFileUrl = (p: string | null) => toAbsoluteUrlFromRequest(request, p);
        const embed = await getFaqEmbedFlags(user._id, gate.apiKeyOid, { resolveFileUrl });
        return sendSuccess(reply, { categories, embed });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to load FAQ constants.";
        return sendError(reply, message, 500, "FAQ_CONSTANTS_GET_FAILED");
      }
    },
  );

  fastify.put(
    "/api/v1/api-keys/:id/faq-constants",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      const user = request.bearerUser!;
      const id = String((request.params as { id?: string })?.id ?? "");
      const gate = await requireActiveOwnedApiKey(user._id, id);
      if (!gate.ok) {
        return mapOwnedApiKeyGate(reply, gate);
      }
      const parsed = categoriesBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, parsed.error.issues[0]?.message ?? "Invalid body.", 400, "INVALID_BODY");
      }
      try {
        const categories = await setFaqConstantCategories(user._id, gate.apiKeyOid, parsed.data.categories);
        return sendSuccess(reply, { categories });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Failed to save categories.";
        if (msg.includes("validation failed") || msg.includes("categories")) {
          return sendError(reply, msg, 400, "VALIDATION_ERROR");
        }
        return sendError(reply, msg, 500, "FAQ_CONSTANTS_PUT_FAILED");
      }
    },
  );

  fastify.patch(
    "/api/v1/api-keys/:id/faq-constants/embed",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      const user = request.bearerUser!;
      const id = String((request.params as { id?: string })?.id ?? "");
      const gate = await requireActiveOwnedApiKey(user._id, id);
      if (!gate.ok) {
        return mapOwnedApiKeyGate(reply, gate);
      }
      const parsed = embedPatchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, parsed.error.issues[0]?.message ?? "Invalid body.", 400, "INVALID_BODY");
      }
      try {
        const resolveFileUrl = (p: string | null) => toAbsoluteUrlFromRequest(request, p);
        if (parsed.data.rotate === true) {
          await rotateEmbedToken(user._id, gate.apiKeyOid, resolveFileUrl);
        }
        let embed = await getFaqEmbedFlags(user._id, gate.apiKeyOid, { resolveFileUrl });
        if (parsed.data.enabled !== undefined) {
          embed = await setEmbedEnabled(user._id, gate.apiKeyOid, parsed.data.enabled, resolveFileUrl);
        }
        if (parsed.data.allowedOrigins !== undefined) {
          embed = await setEmbedAllowedOrigins(user._id, gate.apiKeyOid, parsed.data.allowedOrigins, resolveFileUrl);
        }
        return sendSuccess(reply, { embed });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Failed to update embed settings.";
        if (msg === "EMBED_PLAN_REQUIRED") {
          return sendError(
            reply,
            "Public embed is available on Pro and Scale plans only.",
            403,
            "EMBED_PLAN_REQUIRED",
          );
        }
        if (msg.includes("E11000") || msg.includes("duplicate")) {
          return sendError(reply, "Embed token collision; retry.", 409, "EMBED_TOKEN_DUP");
        }
        return sendError(reply, msg, 500, "FAQ_EMBED_PATCH_FAILED");
      }
    },
  );

  fastify.patch(
    "/api/v1/api-keys/:id/faq-constants/embed/ui",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      const user = request.bearerUser!;
      const id = String((request.params as { id?: string })?.id ?? "");
      const gate = await requireActiveOwnedApiKey(user._id, id);
      if (!gate.ok) {
        return mapOwnedApiKeyGate(reply, gate);
      }
      const parsed = embedUiPatchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, parsed.error.issues[0]?.message ?? "Invalid body.", 400, "INVALID_BODY");
      }
      try {
        const resolveFileUrl = (p: string | null) => toAbsoluteUrlFromRequest(request, p);
        const embed = await setFaqEmbedUiSettings(user._id, gate.apiKeyOid, parsed.data, resolveFileUrl);
        return sendSuccess(reply, { embed });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Failed to update embed appearance.";
        if (msg.includes("validation failed") || msg.includes("embedColor")) {
          return sendError(reply, msg, 400, "VALIDATION_ERROR");
        }
        return sendError(reply, msg, 500, "FAQ_EMBED_UI_PATCH_FAILED");
      }
    },
  );

  fastify.patch(
    "/api/v1/api-keys/:id/faq-constants/embed/assistant-picture",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      const user = request.bearerUser!;
      const id = String((request.params as { id?: string })?.id ?? "");
      const gate = await requireActiveOwnedApiKey(user._id, id);
      if (!gate.ok) {
        return mapOwnedApiKeyGate(reply, gate);
      }
      const contentType = String(request.headers["content-type"] ?? "");
      if (!contentType.includes("multipart/form-data")) {
        return sendError(reply, "Expected multipart/form-data.", 400, "INVALID_CONTENT_TYPE");
      }
      const parts = (request as { parts?: () => AsyncIterable<unknown> }).parts?.();
      if (!parts) {
        return sendError(reply, "Expected multipart/form-data.", 400, "INVALID_CONTENT_TYPE");
      }
      let avatarFile: { buffer: Buffer; filename: string; mimetype: string; size: number } | null = null;
      try {
        for await (const part of parts as AsyncIterable<{ type?: string; fieldname?: string; filename?: string; mimetype?: string; file?: NodeJS.ReadableStream }>) {
          if (part.type === "file" && part.fieldname === "assistantAvatar") {
            const buf = await (await import("node:stream/consumers")).buffer(part.file!);
            avatarFile = {
              buffer: buf,
              filename: String(part.filename ?? "assistant-avatar"),
              mimetype: String(part.mimetype ?? "application/octet-stream"),
              size: buf.length,
            };
            break;
          }
        }
      } catch {
        return sendError(reply, "Failed to read upload.", 400, "MULTIPART_READ_FAILED");
      }
      if (!avatarFile) {
        return sendError(reply, "Missing file field assistantAvatar.", 400, "MISSING_AVATAR_FILE");
      }
      const mime = avatarFile.mimetype || "application/octet-stream";
      if (!isAllowedPublicImageMime(mime)) {
        return sendError(reply, "Unsupported image type.", 400, "INVALID_IMAGE_TYPE");
      }
      if (avatarFile.size <= 0) {
        return sendError(reply, "Image file is empty.", 400, "EMPTY_IMAGE_FILE");
      }
      if (avatarFile.size > MAX_PUBLIC_IMAGE_BYTES) {
        return sendError(reply, "Image file is too large (max 2MB).", 400, "IMAGE_TOO_LARGE");
      }
      try {
        const resolveFileUrl = (p: string | null) => toAbsoluteUrlFromRequest(request, p);
        const embed = await replaceFaqEmbedAssistantPicture(user._id, gate.apiKeyOid, avatarFile, resolveFileUrl);
        return sendSuccess(reply, { embed });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Failed to save assistant picture.";
        return sendError(reply, msg, 500, "FAQ_EMBED_AVATAR_PATCH_FAILED");
      }
    },
  );

  fastify.post(
    "/api/v1/api-keys/:id/faq-constants/categories",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      const user = request.bearerUser!;
      const id = String((request.params as { id?: string })?.id ?? "");
      const gate = await requireActiveOwnedApiKey(user._id, id);
      if (!gate.ok) {
        return mapOwnedApiKeyGate(reply, gate);
      }
      const parsed = valuesBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, parsed.error.issues[0]?.message ?? "Invalid body.", 400, "INVALID_BODY");
      }
      try {
        const categories = await addFaqConstantCategories(user._id, gate.apiKeyOid, parsed.data.values);
        return sendSuccess(reply, { categories });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Failed to add categories.";
        if (msg.includes("validation failed") || msg.includes("categories")) {
          return sendError(reply, msg, 400, "VALIDATION_ERROR");
        }
        return sendError(reply, msg, 500, "FAQ_CONSTANTS_POST_FAILED");
      }
    },
  );

  fastify.delete(
    "/api/v1/api-keys/:id/faq-constants/categories",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      const user = request.bearerUser!;
      const id = String((request.params as { id?: string })?.id ?? "");
      const gate = await requireActiveOwnedApiKey(user._id, id);
      if (!gate.ok) {
        return mapOwnedApiKeyGate(reply, gate);
      }
      const parsed = valuesBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, parsed.error.issues[0]?.message ?? "Invalid body.", 400, "INVALID_BODY");
      }
      try {
        const categories = await removeFaqConstantCategories(user._id, gate.apiKeyOid, parsed.data.values);
        return sendSuccess(reply, { categories });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to remove categories.";
        return sendError(reply, message, 500, "FAQ_CONSTANTS_DELETE_FAILED");
      }
    },
  );
}
