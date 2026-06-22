import type { FastifyInstance } from "fastify";

import { requireBearerAdmin } from "../auth/requireBearerUser.js";
import { AppConfigModel } from "../models/AppConfig.js";
import { deletePublicFile, updatePublicFile } from "../services/publicFilesService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import {
  toAbsoluteUrlFromRequest,
} from "../utils/publicOriginFromRequest.js";
import { isAllowedPublicImageMime, MAX_PUBLIC_IMAGE_BYTES } from "../utils/publicImageUpload.js";

const MAX_LOGO_BYTES = MAX_PUBLIC_IMAGE_BYTES;

function parseBooleanInput(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function normalizeOptionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

async function getOrCreateConfig() {
  return (
    (await AppConfigModel.findOne()) ??
    (await AppConfigModel.create({
      appName: "SapAi",
      openRegistration: true,
      openLogin: true,
    }))
  );
}

export async function registerAppConfigRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/v1/app-config", async (request, reply) => {
    try {
      const config = await getOrCreateConfig();
      const logoIdRaw = config.logo?.fileId;
      const brandLogoFileId =
        typeof logoIdRaw === "string" && logoIdRaw.trim() !== "" ? logoIdRaw.trim() : null;
      const brandLogoPath =
        typeof config.logo?.url === "string" && config.logo.url.trim() !== ""
          ? config.logo.url.trim()
          : brandLogoFileId
            ? `/api/v1/files/${brandLogoFileId}`
            : null;
      const brandLogoUrl = toAbsoluteUrlFromRequest(request, brandLogoPath);

      return sendSuccess(reply, {
        appName: config.appName,
        openRegistration: config.openRegistration,
        openLogin: config.openLogin,
        brandLogoFileId,
        brandLogoUrl,
        brandLogoPath,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load app config.";
      return sendError(reply, message, 500, "APP_CONFIG_FETCH_FAILED");
    }
  });

  fastify.patch(
    "/api/v1/admin/app-config",
    { preHandler: requireBearerAdmin },
    async (request, reply) => {
      try {
        const contentType = String(request.headers["content-type"] ?? "");

        let appName = "";
        let openRegistration: boolean | null = null;
        let openLogin: boolean | null = null;
        let removeLogo = false;
        let logoFile: { buffer: Buffer; filename: string; mimetype: string; size: number } | null =
          null;

        if (contentType.includes("multipart/form-data")) {
          const parts = (request as any).parts?.();
          if (!parts) return sendError(reply, "Expected multipart/form-data.", 400, "INVALID_CONTENT_TYPE");

          for await (const part of parts) {
            if (part.type === "file") {
              if (part.fieldname === "brandLogo") {
                const buf = await (await import("node:stream/consumers")).buffer(part.file);
                logoFile = {
                  buffer: buf,
                  filename: String(part.filename ?? "brand-logo"),
                  mimetype: String(part.mimetype ?? "application/octet-stream"),
                  size: buf.length,
                };
              }
              continue;
            }
            const v = String(part.value ?? "");
            if (part.fieldname === "appName") appName = v.trim();
            if (part.fieldname === "openRegistration") openRegistration = parseBooleanInput(v);
            if (part.fieldname === "openLogin") openLogin = parseBooleanInput(v);
            if (part.fieldname === "removeBrandLogo") removeLogo = parseBooleanInput(v) === true;
          }
        } else {
          const payload = request.body as any;
          appName = String(payload?.appName ?? "").trim();
          openRegistration = parseBooleanInput(payload?.openRegistration);
          openLogin = parseBooleanInput(payload?.openLogin);
          removeLogo = parseBooleanInput(payload?.removeBrandLogo) === true;
        }

        if (!appName || appName.length > 120) {
          return sendError(reply, "App name must be 1–120 characters.", 400, "INVALID_APP_NAME");
        }
        if (openRegistration === null || openLogin === null) {
          return sendError(reply, "openRegistration and openLogin must be booleans.", 400, "INVALID_FLAGS");
        }

        if (logoFile) {
          const mime = logoFile.mimetype || "application/octet-stream";
          if (!isAllowedPublicImageMime(mime)) return sendError(reply, "Unsupported logo image type.", 400, "INVALID_LOGO_TYPE");
          if (logoFile.size <= 0) return sendError(reply, "Logo file is empty.", 400, "EMPTY_LOGO_FILE");
          if (logoFile.size > MAX_LOGO_BYTES) return sendError(reply, "Logo file is too large (max 2MB).", 400, "LOGO_TOO_LARGE");
        }

        const config = await getOrCreateConfig();
        const previousLogoId = normalizeOptionalText(config.logo?.fileId);

        config.appName = appName;
        config.openRegistration = openRegistration;
        config.openLogin = openLogin;

        if (logoFile) {
          const uploaded = await updatePublicFile(previousLogoId, logoFile.buffer, {
            originalFilename: logoFile.filename || "brand-logo",
            contentType: logoFile.mimetype || "application/octet-stream",
          });
          config.logo = { fileId: uploaded.fileId, url: uploaded.urlPath };
        } else if (removeLogo) {
          config.logo = null;
          if (previousLogoId) {
            await deletePublicFile(previousLogoId).catch(() => undefined);
          }
        }

        await config.save();

        const logoIdAfter = normalizeOptionalText(config.logo?.fileId);
        const logoPathAfter =
          typeof config.logo?.url === "string" && config.logo.url.trim() !== ""
            ? config.logo.url.trim()
            : logoIdAfter
              ? `/api/v1/files/${logoIdAfter}`
              : null;
        const logoUrlAfter = toAbsoluteUrlFromRequest(request, logoPathAfter);

        return sendSuccess(reply, {
          appName: config.appName,
          openRegistration: config.openRegistration,
          openLogin: config.openLogin,
          brandLogoFileId: logoIdAfter,
          brandLogoUrl: logoUrlAfter,
          brandLogoPath: logoPathAfter,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to update app settings.";
        return sendError(reply, message, 500, "APP_CONFIG_UPDATE_FAILED");
      }
    },
  );
}

