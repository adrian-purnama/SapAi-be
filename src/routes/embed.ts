import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import mongoose from "mongoose";

import { requireEmbedToken } from "../auth/embedTokenAuth.js";
import { modelLabelsForTask } from "../constants/taskCatalog.js";
import type { NormalizedChatJobCreateBody } from "../schemas/chatJobBody.js";
import { createAndQueueChatJob } from "../services/createChatJobFromAuth.js";
import { LimitError, limitErrorHttpStatus } from "../utils/limitError.js";
import {
  getEmbedFrameAncestorsForRawToken,
  getPublicEmbedBrandingForActiveToken,
  isEmbedTokenActive,
} from "../services/faqEmbedSettings.js";
import {
  recordEmbedVisitSafe,
  resolveEmbedVisitScope,
  type EmbedVisitKind,
} from "../services/recordEmbedVisit.js";
import {
  applySessionMemoryToJob,
  createChatSession,
  endChatSession,
  ChatSessionError,
  chatSessionHttpStatus,
  chatSessionToResponse,
  resolveChatSessionForJob,
} from "../services/chatSessionService.js";
import { toAbsoluteUrlFromRequest } from "../utils/publicOriginFromRequest.js";
import {
  isRecaptchaConfigured,
  RECAPTCHA_EMBED_CHAT_ACTION,
  verifyRecaptchaToken,
} from "../utils/recaptcha.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";

const RAG_MODEL_LABELS = modelLabelsForTask("rag") as [string, ...string[]];
const modelEnum = z.enum(RAG_MODEL_LABELS);

const embedChatBodySchema = z.object({
  message: z.string().trim().min(1, "Message cannot be empty"),
  model: modelEnum.optional(),
  recaptchaToken: z.string().trim().optional(),
  sessionId: z.string().trim().min(1).optional(),
});

function readEmbedTokenFromRequest(request: FastifyRequest): string {
  const q = request.query as Record<string, string | string[] | undefined>;
  const rawQ = q.token;
  const fromQuery = typeof rawQ === "string" ? rawQ : rawQ?.[0];
  const h = request.headers["x-embed-token"];
  const fromHeader = Array.isArray(h) ? h[0] : h;
  return String(fromQuery ?? fromHeader ?? "").trim();
}

function requireEmbedTokenOrReply(request: FastifyRequest, reply: FastifyReply): string | null {
  const token = readEmbedTokenFromRequest(request);
  if (!token) {
    void sendError(reply, "Missing embed token.", 400, "EMBED_TOKEN_REQUIRED");
    return null;
  }
  return token;
}

async function recordVisitIfScoped(
  token: string,
  request: FastifyRequest,
  kind: EmbedVisitKind,
): Promise<void> {
  const visitScope = await resolveEmbedVisitScope(token);
  if (!visitScope) return;
  recordEmbedVisitSafe(
    {
      apiKeyId: visitScope.apiKeyId,
      userId: visitScope.userId,
      request,
      kind,
    },
    request.log,
  );
}

async function handleEmbedStatus(request: FastifyRequest, reply: FastifyReply) {
  const token = requireEmbedTokenOrReply(request, reply);
  if (!token) return;

  const active = await isEmbedTokenActive(token);
  if (!active) {
    return sendError(reply, "Embed not found or disabled.", 404, "EMBED_INACTIVE");
  }

  await recordVisitIfScoped(token, request, "status");

  const resolveFileUrl = (p: string | null) => toAbsoluteUrlFromRequest(request, p);
  const branding = await getPublicEmbedBrandingForActiveToken(token, resolveFileUrl);
  return sendSuccess(reply, {
    active: true,
    assistantName: branding?.assistantName ?? null,
    assistantDescription: branding?.assistantDescription ?? null,
    assistantGreeting: branding?.assistantGreeting ?? null,
    embedColor: branding?.embedColor ?? null,
    assistantProfileUrl: branding?.assistantProfileUrl ?? null,
    aiDisclaimer: branding?.aiDisclaimer ?? null,
    furtherInfoLink: branding?.furtherInfoLink ?? null,
    appBadge: branding?.appBadge ?? null,
  });
}

async function handleEmbedFramePolicy(request: FastifyRequest, reply: FastifyReply) {
  const token = requireEmbedTokenOrReply(request, reply);
  if (!token) return;

  const frameAncestors = await getEmbedFrameAncestorsForRawToken(token);
  if (!frameAncestors) {
    return sendError(reply, "Embed not found or disabled.", 404, "EMBED_INACTIVE");
  }
  return sendSuccess(reply, { frameAncestors });
}

async function handleEmbedCreateSession(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.apiAuth!;
  try {
    const session = await createChatSession(auth.apiKeyId);
    return sendSuccess(reply, chatSessionToResponse(session), 201);
  } catch (err) {
    if (err instanceof ChatSessionError) {
      return sendError(reply, err.message, chatSessionHttpStatus(err.code), err.code);
    }
    throw err;
  }
}

async function handleEmbedEndSession(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const auth = request.apiAuth!;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return sendError(reply, "Chat session not found.", 404, "SESSION_NOT_FOUND");
  }
  try {
    const session = await endChatSession(auth.apiKeyId, id);
    return sendSuccess(reply, chatSessionToResponse(session));
  } catch (err) {
    if (err instanceof ChatSessionError) {
      return sendError(reply, err.message, chatSessionHttpStatus(err.code), err.code);
    }
    throw err;
  }
}

async function handleEmbedChat(request: FastifyRequest, reply: FastifyReply) {
  const parsed = embedChatBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return sendError(reply, "Invalid body", 400, "VALIDATION_ERROR", {
      issues: parsed.error.flatten(),
    });
  }

  if (isRecaptchaConfigured()) {
    const remoteIp = request.ip?.trim() || undefined;
    const recaptcha = await verifyRecaptchaToken(parsed.data.recaptchaToken, {
      remoteIp,
      expectedAction: RECAPTCHA_EMBED_CHAT_ACTION,
    });
    if (!recaptcha.ok) {
      return sendError(reply, recaptcha.message, 400, recaptcha.code);
    }
  }

  const auth = request.apiAuth!;

  let sessionMeta;
  try {
    sessionMeta = await resolveChatSessionForJob({
      apiKeyId: auth.apiKeyId,
      sessionId: parsed.data.sessionId,
      autoCreate: true,
    });
  } catch (err) {
    if (err instanceof ChatSessionError) {
      return sendError(reply, err.message, chatSessionHttpStatus(err.code), err.code);
    }
    throw err;
  }

  // ponytail: default rag model is first catalog label for this task
  const model = parsed.data.model ?? RAG_MODEL_LABELS[0];
  const ragRaw = {
    taskType: "rag" as const,
    model,
    input: [{ role: "user" as const, content: parsed.data.message }],
    maxTokens: 500,
  };
  let body: NormalizedChatJobCreateBody = {
    taskType: "rag",
    model,
    input: ragRaw.input,
    maxTokens: 500,
  };

  if (sessionMeta) {
    body = {
      ...body,
      input: await applySessionMemoryToJob({
        sessionId: sessionMeta.id,
        raw: ragRaw,
        merged: body,
      }),
    };
  }

  let created;
  try {
    created = await createAndQueueChatJob(auth, body, {
      error: (obj, msg) => request.log.error(obj, msg),
      sessionId: sessionMeta?.id,
      session: sessionMeta ?? undefined,
    });
  } catch (err) {
    if (err instanceof LimitError) {
      return sendError(reply, err.message, limitErrorHttpStatus(err.code), err.code);
    }
    throw err;
  }

  recordEmbedVisitSafe(
    {
      apiKeyId: auth.apiKeyId,
      userId: auth.userId,
      request,
      kind: "chat",
    },
    request.log,
  );

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
}

export async function registerEmbedRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/v1/embed/status", handleEmbedStatus);
  fastify.get("/api/v1/embed/frame-policy", handleEmbedFramePolicy);
  fastify.post("/api/v1/embed/sessions", { preHandler: requireEmbedToken }, handleEmbedCreateSession);
  fastify.delete("/api/v1/embed/sessions/:id", { preHandler: requireEmbedToken }, handleEmbedEndSession);
  fastify.post("/api/v1/embed/chat", { preHandler: requireEmbedToken }, handleEmbedChat);
}
