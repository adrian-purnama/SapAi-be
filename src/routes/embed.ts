import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireEmbedToken } from "../auth/embedTokenAuth.js";
import { ALLOWED_CHAT_MODEL_IDS } from "../constants/chatModels.js";
import { createAndQueueChatJob } from "../services/createChatJobFromAuth.js";
import { PlanLimitError } from "../utils/planChatLimits.js";
import {
  getEmbedFrameAncestorsForRawToken,
  getPublicEmbedBrandingForActiveToken,
  isEmbedTokenActive,
} from "../services/faqConstantsService.js";
import {
  recordEmbedVisitSafe,
  resolveEmbedVisitScope,
} from "../services/recordEmbedVisit.js";
import { toAbsoluteUrlFromRequest } from "../utils/publicOriginFromRequest.js";
import {
  isRecaptchaConfigured,
  RECAPTCHA_EMBED_CHAT_ACTION,
  verifyRecaptchaToken,
} from "../utils/recaptcha.js";

const MODEL_LABELS = ALLOWED_CHAT_MODEL_IDS.map((m) => m.label) as unknown as [string, ...string[]];
const modelEnum = z.enum(MODEL_LABELS);

const embedChatBodySchema = z.object({
  message: z.string().trim().min(1, "Message cannot be empty"),
  model: modelEnum.optional(),
  recaptchaToken: z.string().trim().optional(),
});

function readEmbedTokenFromRequest(request: FastifyRequest): string {
  const q = request.query as Record<string, string | string[] | undefined>;
  const rawQ = q.token;
  const fromQuery = typeof rawQ === "string" ? rawQ : rawQ?.[0];
  const h = request.headers["x-embed-token"];
  const fromHeader = Array.isArray(h) ? h[0] : h;
  return String(fromQuery ?? fromHeader ?? "").trim();
}

export async function registerEmbedRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/v1/embed/status", async (request, reply) => {
    const token = readEmbedTokenFromRequest(request);
    if (!token) {
      return reply.code(400).send({ message: "Missing embed token.", code: "EMBED_TOKEN_REQUIRED" });
    }
    const active = await isEmbedTokenActive(token);
    if (!active) {
      return reply.code(404).send({ message: "Embed not found or disabled.", code: "EMBED_INACTIVE" });
    }
    const visitScope = await resolveEmbedVisitScope(token);
    if (visitScope) {
      recordEmbedVisitSafe(
        {
          apiKeyId: visitScope.apiKeyId,
          userId: visitScope.userId,
          request,
          kind: "status",
        },
        request.log,
      );
    }
    const resolveFileUrl = (p: string | null) => toAbsoluteUrlFromRequest(request, p);
    const branding = await getPublicEmbedBrandingForActiveToken(token, resolveFileUrl);
    return reply.send({
      ok: true,
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
  });

  fastify.get("/api/v1/embed/frame-policy", async (request, reply) => {
    const token = readEmbedTokenFromRequest(request);
    if (!token) {
      return reply.code(400).send({ message: "Missing embed token.", code: "EMBED_TOKEN_REQUIRED" });
    }
    const frameAncestors = await getEmbedFrameAncestorsForRawToken(token);
    if (!frameAncestors) {
      return reply.code(404).send({ message: "Embed not found or disabled.", code: "EMBED_INACTIVE" });
    }
    return reply.send({ frameAncestors });
  });

  fastify.post(
    "/api/v1/embed/chat",
    { preHandler: requireEmbedToken },
    async (request, reply) => {
      const parsed = embedChatBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          message: "Invalid body",
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
          return reply.code(400).send({
            message: recaptcha.message,
            code: recaptcha.code,
          });
        }
      }

      const auth = request.apiAuth!;

      //TODO:model here is predefined ?
      const model = parsed.data.model ?? "OCT3Q";
      const body = {
        taskType: "rag" as const,
        model,
        input: [{ role: "user" as const, content: parsed.data.message }],
        maxTokens: 500,
      };

      let created;
      try {
        created = await createAndQueueChatJob(auth, body, {
          error: (obj, msg) => request.log.error(obj, msg),
        });
      } catch (err) {
        if (err instanceof PlanLimitError) {
          return reply.code(400).send({ message: err.message, code: err.code });
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

      return {
        ok: true,
        job: {
          id: created.jobId,
          status: created.status,
          taskType: created.taskType,
          model: created.model,
          createdAt: created.createdAt,
        },
      };
    },
  );
}
