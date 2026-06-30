import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";

import { requireApiKeyOrEmbedToken } from "../auth/embedTokenAuth.js";
import { requireApiKey } from "../auth/requireApiKey.js";
import { ChatJobModel, CHAT_JOB_STATUS_VALUES } from "../models/ChatJob.js";
import {
  CHAT_TASK_TYPES,
  chatJobCreateBodySchema,
  normalizeChatJobCreateBody,
} from "../schemas/chatJobBody.js";
import { MAX_PLAN_OCR_MB, ocrJsonBodyLimitBytes } from "../constants/chatLimits.js";
import { createAndQueueChatJob } from "../services/createChatJobFromAuth.js";
import {
  applySessionMemoryToJob,
  ChatSessionError,
  chatSessionHttpStatus,
  chatSessionToResponse,
  getGenerateSessionIdFromRaw,
  getSessionIdFromRaw,
  resolveChatSessionForJob,
} from "../services/chatSessionService.js";
import {
  getDefaultPlanFromRegistry,
  getPlanBySlugFromRegistry,
} from "../services/planRegistry.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { getPlanTaskAccessView } from "../utils/planAccess.js";
import { PlanLimitError, planLimitHttpStatus } from "../utils/planChatLimits.js";
import { buildStructuredOutputSystemPrompt } from "../utils/buildStructuredOutputSystemPrompt.js";
import { toPublicChatJob } from "../utils/toPublicChatJob.js";

export async function registerChatRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/v1/chat/models", { preHandler: requireApiKey }, async (request, reply) => {
    const auth = request.apiAuth!;
    const plan = getPlanBySlugFromRegistry(auth.plan) ?? getDefaultPlanFromRegistry();
    const access = plan ? getPlanTaskAccessView(plan) : { taskTypes: [], modelsByTask: {} };
    return sendSuccess(reply, access);
  });

  fastify.get("/api/v1/chat/task-types", { preHandler: requireApiKey }, async (request, reply) => {
    const auth = request.apiAuth!;
    const plan = getPlanBySlugFromRegistry(auth.plan) ?? getDefaultPlanFromRegistry();
    const taskTypes = plan ? getPlanTaskAccessView(plan).taskTypes : [...CHAT_TASK_TYPES];
    return sendSuccess(reply, taskTypes);
  });

  fastify.get("/api/v1/chat/statuses", { preHandler: requireApiKey }, async (_request, reply) =>
    sendSuccess(reply, [...CHAT_JOB_STATUS_VALUES]),
  );

  fastify.post(
    "/api/v1/chat",
    { preHandler: requireApiKey, bodyLimit: ocrJsonBodyLimitBytes(MAX_PLAN_OCR_MB) },
    async (request, reply) => {
    const parsed = chatJobCreateBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, "Invalid body", 400, "VALIDATION_ERROR", {
        issues: parsed.error.flatten(),
      });
    }

    const auth = request.apiAuth!;
    const raw = parsed.data;

    let sessionMeta = null;
    try {
      sessionMeta = await resolveChatSessionForJob({
        apiKeyId: auth.apiKeyId,
        sessionId: getSessionIdFromRaw(raw),
        generateSessionId: getGenerateSessionIdFromRaw(raw),
      });
    } catch (err) {
      if (err instanceof ChatSessionError) {
        return sendError(reply, err.message, chatSessionHttpStatus(err.code), err.code);
      }
      throw err;
    }

    let merged;
    try {
      const body = await normalizeChatJobCreateBody(raw, auth.userId);

      let jobInput = body.input;
      if (sessionMeta) {
        jobInput = await applySessionMemoryToJob({
          sessionId: sessionMeta.id,
          raw,
          merged: body,
        });
      } else if (raw.taskType !== "translate" && raw.taskType !== "ocr") {
        const template = raw.outputJsonTemplate?.trim();
        if (template && template.length > 0) {
          jobInput = [
            {
              role: "system" as const,
              content: buildStructuredOutputSystemPrompt(template),
            },
            ...body.input,
          ];
        }
      }

      if (sessionMeta && (raw.taskType === "chat" || raw.taskType === "rag")) {
        const template = raw.outputJsonTemplate?.trim();
        if (template && template.length > 0) {
          jobInput = [
            {
              role: "system" as const,
              content: buildStructuredOutputSystemPrompt(template),
            },
            ...jobInput,
          ];
        }
      }

      merged = { ...body, input: jobInput };
    } catch (err) {
      if (err instanceof PlanLimitError) {
        return sendError(reply, err.message, planLimitHttpStatus(err.code), err.code);
      }
      throw err;
    }

    let created;
    try {
      created = await createAndQueueChatJob(auth, merged, {
        error: (obj, msg) => request.log.error(obj, msg),
        sessionId: sessionMeta?.id,
        session: sessionMeta ?? undefined,
      });
    } catch (err) {
      if (err instanceof PlanLimitError) {
        return sendError(reply, err.message, planLimitHttpStatus(err.code), err.code);
      }
      throw err;
    }

    return sendSuccess(reply, {
      job: {
        id: created.jobId,
        status: created.status,
        taskType: created.taskType,
        model: created.model,
        createdAt: created.createdAt,
      },
      ...(created.session ? chatSessionToResponse(created.session) : {}),
    });
  });

  fastify.get("/api/v1/chat/jobs/:id", { preHandler: requireApiKeyOrEmbedToken }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = request.apiAuth!;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(reply, "Job not found.", 404, "NOT_FOUND");
    }
    const job = await ChatJobModel.findOne({
      _id: new mongoose.Types.ObjectId(id),
      apiKeyId: new mongoose.Types.ObjectId(auth.apiKeyId),
    })
      .select("-userId -plan -apiKeyId -input -attempts -maxAttempts -__v")
      .lean()
      .exec();
    if (!job) {
      return sendError(reply, "Job not found.", 404, "NOT_FOUND");
    }
    return sendSuccess(reply, toPublicChatJob(job));
  });
}
