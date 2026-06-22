import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import mongoose from "mongoose";

import { requireBearerUser } from "../auth/requireBearerUser.js";
import { ChatJobModel } from "../models/ChatJob.js";
import {
  getRagAnalyticsQueries,
  getRagAnalyticsSummary,
  resolveRagGap,
  type RagAnalyticsFilters,
} from "../services/ragAnalyticsService.js";
import { resolveEffectivePlanForUser } from "../services/planRegistry.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { toPublicChatJob } from "../utils/toPublicChatJob.js";
import { clampUsageAndAnalyticsDateRange } from "../utils/planAccess.js";
import {
  aggregateUsageSummary,
  assertRagAnalyticsAccess,
  loadOwnedApiKeyLean,
  mergeRagFiltersIntoJobMatch,
  parseApiKeyRouteId,
  parseRagAnalyticsFiltersFromQuery,
} from "./apiKeyShared.js";

async function handleRagSummary(request: FastifyRequest, reply: FastifyReply) {
  const user = request.bearerUser!;
  const id = parseApiKeyRouteId(request, reply);
  if (!id) return;

  const access = await assertRagAnalyticsAccess(user, id, reply);
  if (!access) return;

  const q = request.query as Record<string, unknown>;
  const rf = parseRagAnalyticsFiltersFromQuery(q);
  const to0 = rf.to ?? new Date();
  const from0 = rf.from ?? new Date(to0.getTime() - 30 * 86400_000);
  const { from, to } = clampUsageAndAnalyticsDateRange(access.plan, from0, to0);
  const data = await getRagAnalyticsSummary(user._id, access.apiKeyOid, {
    ...rf,
    from,
    to,
  });
  return sendSuccess(reply, data);
}

async function handleRagResolveGap(request: FastifyRequest, reply: FastifyReply) {
  const user = request.bearerUser!;
  const id = parseApiKeyRouteId(request, reply);
  if (!id) return;

  const access = await assertRagAnalyticsAccess(user, id, reply);
  if (!access) return;

  const body = request.body as { jobId?: string; fingerprint?: string | null } | undefined;
  const jobId = typeof body?.jobId === "string" ? body.jobId.trim() : "";
  const fingerprint = typeof body?.fingerprint === "string" ? body.fingerprint : body?.fingerprint;
  if (!jobId && !fingerprint?.trim()) {
    return sendError(reply, "Provide jobId or fingerprint.", 400, "INVALID_BODY");
  }

  try {
    const result = await resolveRagGap(user._id, access.apiKeyOid, {
      ...(jobId ? { jobId } : {}),
      ...(fingerprint?.trim() ? { fingerprint } : {}),
    });
    return sendSuccess(reply, { modifiedCount: result.modifiedCount, answerable: "yes" });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to resolve gap.";
    return sendError(reply, message, 400, "RAG_GAP_RESOLVE_FAILED");
  }
}

async function handleRagQueries(request: FastifyRequest, reply: FastifyReply) {
  const user = request.bearerUser!;
  const id = parseApiKeyRouteId(request, reply);
  if (!id) return;

  const access = await assertRagAnalyticsAccess(user, id, reply);
  if (!access) return;

  const q = request.query as Record<string, unknown>;
  const rf = parseRagAnalyticsFiltersFromQuery(q);
  const { from, to } = clampUsageAndAnalyticsDateRange(access.plan, rf.from, rf.to);
  const bounded: RagAnalyticsFilters = { ...rf, from, to };
  const page = Math.max(1, Number(q.page ?? "1") || 1);
  const limitRaw = Number(q.limit ?? "20") || 20;
  const limit = Math.min(Math.max(limitRaw, 1), 50);

  const data = await getRagAnalyticsQueries(user._id, access.apiKeyOid, bounded, page, limit);
  return sendSuccess(reply, {
    ...data,
    filters: {
      from: bounded.from?.toISOString() ?? null,
      to: bounded.to?.toISOString() ?? null,
      answerable: bounded.answerable ?? null,
      intent: bounded.intent ?? null,
      category: bounded.category ?? null,
    },
  });
}

async function handleUsage(request: FastifyRequest, reply: FastifyReply) {
  const user = request.bearerUser!;
  const id = parseApiKeyRouteId(request, reply);
  if (!id) return;

  const key = await loadOwnedApiKeyLean(user._id, id);
  if (!key) return sendError(reply, "API key not found.", 404, "NOT_FOUND");

  const DEFAULT_PAGE_SIZE = 10;
  const MAX_PAGE_SIZE = 50;
  const q = request.query as Record<string, unknown>;
  const page = Math.max(1, Number(q?.page ?? "1") || 1);
  const limitRaw = Number(q?.limit ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE;
  const limit = Math.min(Math.max(limitRaw, 1), MAX_PAGE_SIZE);
  const status = String(q?.status ?? "").trim();
  const taskType = String(q?.taskType ?? "").trim();

  const apiKeyOid = new mongoose.Types.ObjectId(id);
  const jobMatch: Record<string, unknown> = { userId: user._id, apiKeyId: apiKeyOid };
  if (status) jobMatch.status = status;
  if (taskType) jobMatch.taskType = taskType;

  const plan = resolveEffectivePlanForUser(user);
  if (!plan) {
    return sendError(reply, "No subscription plan is assigned to this account.", 403, "NO_PLAN");
  }

  const ragFilters = parseRagAnalyticsFiltersFromQuery(q);
  const { from, to } = clampUsageAndAnalyticsDateRange(plan, ragFilters.from, ragFilters.to);
  const boundedRagFilters: RagAnalyticsFilters = { ...ragFilters, from, to };
  mergeRagFiltersIntoJobMatch(jobMatch, boundedRagFilters);

  const summary = await aggregateUsageSummary(user._id, apiKeyOid);
  const totalMatching = await ChatJobModel.countDocuments(jobMatch);
  const docs = await ChatJobModel.find(jobMatch)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const items = docs.map((doc) => toPublicChatJob(doc));

  return sendSuccess(reply, {
    key: {
      id: key._id.toString(),
      label: key.label,
      prefix: key.prefix,
      ipAllowlist: key.ipAllowlist ?? [],
      ipAllowlistCount: (key.ipAllowlist ?? []).length,
      lastUsedAt: key.lastUsedAt ? new Date(key.lastUsedAt).toISOString() : null,
      revokedAt: key.revokedAt ? new Date(key.revokedAt).toISOString() : null,
      createdAt: key.createdAt ? new Date(key.createdAt).toISOString() : null,
    },
    summary,
    jobs: {
      items,
      total: totalMatching,
      page,
      limit,
      filters: {
        status: status || null,
        taskType: taskType || null,
        from: boundedRagFilters.from?.toISOString() ?? null,
        to: boundedRagFilters.to?.toISOString() ?? null,
        answerable: boundedRagFilters.answerable ?? null,
        intent: boundedRagFilters.intent ?? null,
        category: boundedRagFilters.category ?? null,
      },
    },
  });
}

export async function registerApiKeyAnalyticsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/api/v1/api-keys/:id/rag-analytics/summary",
    { preHandler: requireBearerUser },
    handleRagSummary,
  );
  fastify.post(
    "/api/v1/api-keys/:id/rag-analytics/resolve-gap",
    { preHandler: requireBearerUser },
    handleRagResolveGap,
  );
  fastify.get(
    "/api/v1/api-keys/:id/rag-analytics/queries",
    { preHandler: requireBearerUser },
    handleRagQueries,
  );
  fastify.get("/api/v1/api-keys/:id/usage", { preHandler: requireBearerUser }, handleUsage);
}
