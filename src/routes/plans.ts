import type { FastifyInstance } from "fastify";
import { buffer as readStreamToBuffer } from "node:stream/consumers";
import { z } from "zod";

import { requireBearerAdmin } from "../auth/requireBearerUser.js";
import { getPublicTaskCatalog } from "../constants/taskCatalog.js";
import {
  createPlan,
  deletePlan,
  getPlanById,
  listPlans,
  removePlanImage,
  setPlanImage,
  updatePlan,
} from "../services/plansService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import {
  buildPricingPublicPayload,
  filterPricingPlans,
} from "../utils/planPricingPublic.js";
import { toAbsoluteUrlFromRequest } from "../utils/publicOriginFromRequest.js";
import { isAllowedPublicImageMime, MAX_PUBLIC_IMAGE_BYTES } from "../utils/publicImageUpload.js";
import { planCreateBodySchema, planPatchBodySchema } from "../validation/planSchemas.js";

export async function registerPlanRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/v1/pricing/plans", async (request, reply) => {
    try {
      const all = await listPlans();
      const visible = filterPricingPlans(all);
      const payload = buildPricingPublicPayload(visible, (fileId) => {
        if (!fileId) return null;
        return toAbsoluteUrlFromRequest(request, `/api/v1/files/${fileId}`);
      });
      return sendSuccess(reply, payload);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load pricing plans.";
      return sendError(reply, message, 500, "PRICING_PLANS_FAILED");
    }
  });

  fastify.get("/api/v1/admin/task-catalog", { preHandler: requireBearerAdmin }, async (_request, reply) => {
    return sendSuccess(reply, { catalog: getPublicTaskCatalog() });
  });

  fastify.get("/api/v1/admin/plans", { preHandler: requireBearerAdmin }, async (_request, reply) => {
    try {
      const plans = await listPlans();
      return sendSuccess(reply, { plans });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to list plans.";
      return sendError(reply, message, 500, "PLANS_LIST_FAILED");
    }
  });

  fastify.get("/api/v1/admin/plans/:id", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return sendError(reply, "Invalid plan id.", 400, "INVALID_PARAMS");

    try {
      const plan = await getPlanById(params.data.id);
      if (!plan) return sendError(reply, "Plan not found.", 404, "NOT_FOUND");
      return sendSuccess(reply, { plan });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load plan.";
      return sendError(reply, message, 500, "PLAN_FETCH_FAILED");
    }
  });

  fastify.post("/api/v1/admin/plans", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const body = planCreateBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, body.error.issues[0]?.message ?? "Invalid request body.", 400, "INVALID_BODY");
    }

    try {
      const plan = await createPlan(body.data);
      return sendSuccess(reply, { plan }, 201);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to create plan.";
      const code = message.includes("slug") ? "SLUG_EXISTS" : "PLAN_CREATE_FAILED";
      return sendError(reply, message, 400, code);
    }
  });

  fastify.patch("/api/v1/admin/plans/:id", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return sendError(reply, "Invalid plan id.", 400, "INVALID_PARAMS");

    const body = planPatchBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, body.error.issues[0]?.message ?? "Invalid request body.", 400, "INVALID_BODY");
    }

    try {
      const plan = await updatePlan(params.data.id, body.data);
      return sendSuccess(reply, { plan });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to update plan.";
      const status = message === "Plan not found." ? 404 : 400;
      const code = status === 404 ? "NOT_FOUND" : "PLAN_UPDATE_FAILED";
      return sendError(reply, message, status, code);
    }
  });

  fastify.delete("/api/v1/admin/plans/:id", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return sendError(reply, "Invalid plan id.", 400, "INVALID_PARAMS");

    try {
      await deletePlan(params.data.id);
      return sendSuccess(reply, { message: "Plan deleted." });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to delete plan.";
      const status = message === "Plan not found." ? 404 : 400;
      const code = status === 404 ? "NOT_FOUND" : "PLAN_DELETE_FAILED";
      return sendError(reply, message, status, code);
    }
  });

  fastify.post("/api/v1/admin/plans/:id/image", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return sendError(reply, "Invalid plan id.", 400, "INVALID_PARAMS");

    try {
      const contentType = String(request.headers["content-type"] ?? "");
      if (!contentType.includes("multipart/form-data")) {
        return sendError(reply, "Expected multipart/form-data.", 400, "INVALID_CONTENT_TYPE");
      }

      const parts = (request as { parts?: () => AsyncIterable<unknown> }).parts?.();
      if (!parts) return sendError(reply, "Expected multipart/form-data.", 400, "INVALID_CONTENT_TYPE");

      let imageFile: { buffer: Buffer; filename: string; mimetype: string; size: number } | null = null;

      for await (const part of parts as AsyncIterable<{
        type: string;
        fieldname: string;
        file?: NodeJS.ReadableStream;
        filename?: string;
        mimetype?: string;
      }>) {
        if (part.type !== "file" || part.fieldname !== "image") continue;
        const buf = await readStreamToBuffer(part.file!);
        imageFile = {
          buffer: buf,
          filename: String(part.filename ?? "plan-image"),
          mimetype: String(part.mimetype ?? "application/octet-stream"),
          size: buf.length,
        };
      }

      if (!imageFile) return sendError(reply, "Missing image file.", 400, "MISSING_IMAGE");
      if (!isAllowedPublicImageMime(imageFile.mimetype)) {
        return sendError(reply, "Unsupported image type.", 400, "INVALID_IMAGE_TYPE");
      }
      if (imageFile.size <= 0) return sendError(reply, "Image file is empty.", 400, "EMPTY_IMAGE_FILE");
      if (imageFile.size > MAX_PUBLIC_IMAGE_BYTES) {
        return sendError(reply, "Image file is too large (max 2MB).", 400, "IMAGE_TOO_LARGE");
      }

      const plan = await setPlanImage(params.data.id, imageFile.buffer, {
        originalFilename: imageFile.filename,
        contentType: imageFile.mimetype,
      });

      const imageUrl = plan.imageFileId
        ? toAbsoluteUrlFromRequest(request, `/api/v1/files/${plan.imageFileId}`)
        : null;

      return sendSuccess(reply, { plan, imageUrl });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to upload plan image.";
      const status = message === "Plan not found." ? 404 : 400;
      return sendError(reply, message, status, status === 404 ? "NOT_FOUND" : "PLAN_IMAGE_UPLOAD_FAILED");
    }
  });

  fastify.delete("/api/v1/admin/plans/:id/image", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return sendError(reply, "Invalid plan id.", 400, "INVALID_PARAMS");

    try {
      const plan = await removePlanImage(params.data.id);
      return sendSuccess(reply, { plan });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to remove plan image.";
      const status = message === "Plan not found." ? 404 : 400;
      return sendError(reply, message, status, status === 404 ? "NOT_FOUND" : "PLAN_IMAGE_REMOVE_FAILED");
    }
  });
}
