import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";

import { authenticatePlainEmbedToken, requireApiKeyOrEmbedToken } from "../auth/embedTokenAuth.js";
import { authenticatePlainApiKey, headerString, requireApiKey } from "../auth/requireApiKey.js";
import { consumeWsStreamTicket, issueWsStreamTicket } from "../auth/wsStreamTicket.js";
import { ChatJobModel, CHAT_JOB_STATUS_VALUES } from "../models/ChatJob.js";
import {
  CHAT_TASK_TYPES,
  chatJobCreateBodySchema,
  normalizeChatJobCreateBody,
} from "../schemas/chatJobBody.js";
import { MAX_PLAN_OCR_MB, ocrJsonBodyLimitBytes } from "../constants/chatLimits.js";
import { createAndQueueChatJob } from "../services/createChatJobFromAuth.js";
import {
  getDefaultPlanFromRegistry,
  getPlanBySlugFromRegistry,
} from "../services/planRegistry.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { getPlanTaskAccessView } from "../utils/planAccess.js";
import { PlanLimitError, planLimitHttpStatus } from "../utils/planChatLimits.js";
import { buildStructuredOutputSystemPrompt } from "../utils/buildStructuredOutputSystemPrompt.js";
import { toPublicChatJob } from "../utils/toPublicChatJob.js";
import {
  shutdownChatJobStatusWsHub,
  subscribeChatJobSocket,
  unsubscribeChatJobSocket,
} from "../ws/chatJobStatusHub.js";

export async function registerChatRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(websocket);
  fastify.addHook("onClose", async () => {
    shutdownChatJobStatusWsHub();
  });
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

    let merged;
    try {
      const body = await normalizeChatJobCreateBody(raw, auth.userId);

      let jobInput = body.input;
      if (raw.taskType !== "translate" && raw.taskType !== "ocr") {
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

  fastify.post(
    "/api/v1/chat/jobs/:id/ws-ticket",
    { preHandler: requireApiKeyOrEmbedToken },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const auth = request.apiAuth!;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return sendError(reply, "Job not found.", 404, "NOT_FOUND");
      }
      const job = await ChatJobModel.findOne({
        _id: new mongoose.Types.ObjectId(id),
        apiKeyId: new mongoose.Types.ObjectId(auth.apiKeyId),
      })
        .select("_id")
        .lean();
      if (!job) {
        return sendError(reply, "Job not found.", 404, "NOT_FOUND");
      }
      const embedHdr = headerString(request.headers["x-embed-token"]);
      const apiKeyHdr = headerString(request.headers["x-api-key"]);
      const issued = issueWsStreamTicket({
        jobId: id,
        embedToken: embedHdr,
        apiKey: apiKeyHdr,
      });
      return sendSuccess(reply, { ticket: issued.ticket, expiresInSec: issued.expiresInSec });
    },
  );

  fastify.get(
    "/api/v1/chat/jobs/:id/stream",
    { websocket: true },
    async (socket, request) => {
      const WS_OPEN = 1;
      const { id } = request.params as { id: string };
      const q = request.query as Record<string, string | string[] | undefined>;
      const ticketRaw = q.ticket;
      const ticketStr = typeof ticketRaw === "string" ? ticketRaw : ticketRaw?.[0];
      const embedRaw = q.embedToken;
      const embedStr = typeof embedRaw === "string" ? embedRaw : embedRaw?.[0];
      const apiKeyRaw = q.apiKey;
      const apiKeyStr = typeof apiKeyRaw === "string" ? apiKeyRaw : apiKeyRaw?.[0];

      let embedToUse = embedStr?.trim() ?? "";
      let apiKeyToUse = apiKeyStr ?? "";
      if (ticketStr?.trim()) {
        const consumed = consumeWsStreamTicket(ticketStr.trim(), id);
        if (!consumed) {
          socket.close(1008, "unauthorized");
          return;
        }
        embedToUse = consumed.embedToken ?? "";
        apiKeyToUse = consumed.apiKey ?? "";
      }

      const auth = embedToUse
        ? await authenticatePlainEmbedToken(embedToUse, request)
        : await authenticatePlainApiKey(apiKeyToUse, request);
      if (!auth.ok) {
        socket.close(1008, "unauthorized");
        return;
      }

      if (!mongoose.Types.ObjectId.isValid(id)) {
        socket.close(1008, "not_found");
        return;
      }

      const job = await ChatJobModel.findOne({
        _id: new mongoose.Types.ObjectId(id),
        apiKeyId: new mongoose.Types.ObjectId(auth.ctx.apiKeyId),
      })
        .select("-userId -plan -apiKeyId -input -attempts -maxAttempts -__v")
        .lean()
        .exec();

      if (!job) {
        socket.close(1008, "not_found");
        return;
      }

      const jobId = id;
      subscribeChatJobSocket(jobId, socket);
      const cleanup = () => {
        unsubscribeChatJobSocket(jobId, socket);
      };
      socket.once("close", cleanup);

      const payload = toPublicChatJob(job);
      try {
        if (socket.readyState === WS_OPEN) {
          socket.send(JSON.stringify(payload));
        }
      } catch {
        cleanup();
        return;
      }

      const terminal =
        payload.status === "completed_partial" ||
        payload.status === "completed_full" ||
        payload.status === "failed" ||
        payload.status === "cancelled";
      if (terminal) {
        try {
          socket.close(1000, "job_terminal");
        } catch {
          /* ignore */
        }
      }
    },
  );
}
