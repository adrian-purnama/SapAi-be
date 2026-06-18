import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import net from "node:net";
import mongoose from "mongoose";
import { z } from "zod";

import { requireBearerUser } from "../auth/requireBearerUser.js";
import { ApiKeyModel } from "../models/ApiKey.js";
import type { UserDocument } from "../models/User.js";
import { ChatJobModel } from "../models/ChatJob.js";
import { deleteAllFaqDataForApiKeyInSession } from "../services/faqDocumentsService.js";
import { deleteFaqChunkPointsByApiKeyFromQdrant } from "../services/qdrantFaqChunksService.js";
import { FAQ_ANSWERABLE_VALUES, FAQ_INTENT_VALUES } from "../constants/faqDocument.js";
import {
  getRagAnalyticsQueries,
  getRagAnalyticsSummary,
  resolveRagGap,
  type RagAnalyticsFilters,
} from "../services/ragAnalyticsService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { sha256Hex } from "../utils/sha256.js";
import { toPublicChatJob } from "../utils/toPublicChatJob.js";
import { resolvePlanForUser, type PlanSnapshot } from "../services/planRegistry.js";
import {
  clampUsageAndAnalyticsDateRange,
  planAllowsRagAnalytics,
} from "../utils/planAccess.js";
import { syncUserApiKeysToPlan } from "../services/apiKeyPlanSyncService.js";

type ApiKeyJobStats = {
  totalJobs: number;
  completed: number;
  failed: number;
  cancelled: number;
  inFlight: number;
  totalTokens: number;
  lastJobAt: string | null;
};

const EMPTY_JOB_STATS: ApiKeyJobStats = {
  totalJobs: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  inFlight: 0,
  totalTokens: 0,
  lastJobAt: null,
};

function generateApiKey(): string {
  const secret = crypto.randomBytes(32).toString("base64url");
  return `sapai_sk_${secret}`;
}

function parseIpAllowlist(raw: unknown): string[] {
  if (!raw) return [];
  const s = String(raw);
  const items = s
    .split(/[\n,]+/g)
    .map((v) => v.trim())
    .filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const ip of items) {
    if (seen.has(ip)) continue;
    seen.add(ip);
    out.push(ip);
  }
  // Support sentinel meaning "allow all"
  if (out.includes("0.0.0.0")) return [];
  return out;
}

function validateExactIps(ips: string[]): string | null {
  for (const ip of ips) {
    if (net.isIP(ip) === 0) return `Invalid IP address: ${ip}`;
  }
  return null;
}

function validateOptionalEnum(value: string, allowed: readonly string[]): string | undefined {
  const v = value.trim();
  if (!v) return undefined;
  return allowed.includes(v) ? v : undefined;
}

function parseIsoDate(v: string): Date | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseRagAnalyticsFiltersFromQuery(q: Record<string, unknown>): RagAnalyticsFilters {
  return {
    from: parseIsoDate(String(q.from ?? "")),
    to: parseIsoDate(String(q.to ?? "")),
    answerable: validateOptionalEnum(String(q.answerable ?? ""), FAQ_ANSWERABLE_VALUES),
    intent: validateOptionalEnum(String(q.intent ?? ""), FAQ_INTENT_VALUES),
    category: String(q.category ?? "").trim() || undefined,
  };
}

function mergeRagFiltersIntoJobMatch(jobMatch: Record<string, unknown>, rf: RagAnalyticsFilters): void {
  const and: Record<string, unknown>[] = Array.isArray(jobMatch.$and)
    ? ([...(jobMatch.$and as Record<string, unknown>[])] as Record<string, unknown>[])
    : [];

  if (rf.from != null || rf.to != null) {
    const range: Record<string, Date> = {};
    if (rf.from != null) range.$gte = rf.from;
    if (rf.to != null) range.$lte = rf.to;
    jobMatch.createdAt = range;
  }
  if (rf.answerable) jobMatch["ragAnalysis.answerable"] = rf.answerable;
  if (rf.intent) jobMatch["ragAnalysis.intent"] = rf.intent;
  if (rf.category === "__uncategorized") {
    and.push({
      $or: [{ "ragAnalysis.category": null }, { "ragAnalysis.category": { $exists: false } }],
    });
  } else if (rf.category) {
    jobMatch["ragAnalysis.category"] = rf.category;
  }

  if (and.length > 0) {
    jobMatch.$and = and;
  }
}

function parseApiKeyRouteId(request: FastifyRequest, reply: FastifyReply): string | null {
  const id = String((request.params as { id?: string })?.id ?? "");
  if (!mongoose.isValidObjectId(id)) {
    sendError(reply, "Invalid key id.", 400, "INVALID_ID");
    return null;
  }
  return id;
}

function assertActivePlan(user: UserDocument, reply: FastifyReply): PlanSnapshot | null {
  const plan = resolvePlanForUser(user.plan);
  if (!plan) {
    sendError(reply, "No subscription plan is assigned to this account.", 403, "NO_PLAN");
    return null;
  }
  if (!plan.isActive) {
    sendError(reply, "Your subscription plan is not active.", 403, "PLAN_INACTIVE");
    return null;
  }
  return plan;
}

async function loadOwnedApiKeyLean(userId: mongoose.Types.ObjectId, id: string) {
  return ApiKeyModel.findOne({ _id: new mongoose.Types.ObjectId(id), userId }).lean();
}

async function assertRagAnalyticsAccess(
  user: UserDocument,
  id: string,
  reply: FastifyReply,
): Promise<{ plan: PlanSnapshot; apiKeyOid: mongoose.Types.ObjectId } | null> {
  const key = await loadOwnedApiKeyLean(user._id, id);
  if (!key) {
    sendError(reply, "API key not found.", 404, "NOT_FOUND");
    return null;
  }

  const plan = resolvePlanForUser(user.plan);
  if (!plan) {
    sendError(reply, "No subscription plan is assigned to this account.", 403, "NO_PLAN");
    return null;
  }
  if (!planAllowsRagAnalytics(plan)) {
    sendError(
      reply,
      "RAG analytics is not included in your subscription plan.",
      403,
      "RAG_ANALYTICS_PLAN",
    );
    return null;
  }

  return { plan, apiKeyOid: new mongoose.Types.ObjectId(id) };
}

async function aggregateJobStatsByKeyIds(
  userId: mongoose.Types.ObjectId,
  keyIds: mongoose.Types.ObjectId[],
): Promise<Map<string, ApiKeyJobStats>> {
  const statsByKeyId = new Map<string, ApiKeyJobStats>();
  if (keyIds.length === 0) return statsByKeyId;

  const rows = await ChatJobModel.aggregate<{
    _id: mongoose.Types.ObjectId;
    totalJobs: number;
    completed: number;
    failed: number;
    cancelled: number;
    inFlight: number;
    totalTokens: number;
    lastJobAt: Date | null;
  }>([
    { $match: { userId, apiKeyId: { $in: keyIds } } },
    {
      $group: {
        _id: "$apiKeyId",
        totalJobs: { $sum: 1 },
        completed: {
          $sum: {
            $cond: [{ $in: ["$status", ["completed_partial", "completed_full"]] }, 1, 0],
          },
        },
        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
        inFlight: {
          $sum: {
            $cond: [{ $in: ["$status", ["pending", "queued", "running"]] }, 1, 0],
          },
        },
        totalTokens: { $sum: { $ifNull: ["$result.totalTokens", 0] } },
        lastJobAt: { $max: "$createdAt" },
      },
    },
  ]);

  for (const row of rows) {
    statsByKeyId.set(String(row._id), {
      totalJobs: row.totalJobs,
      completed: row.completed,
      failed: row.failed,
      cancelled: row.cancelled,
      inFlight: row.inFlight,
      totalTokens: row.totalTokens,
      lastJobAt: row.lastJobAt ? new Date(row.lastJobAt).toISOString() : null,
    });
  }

  return statsByKeyId;
}

function toPublicKeyDto(
  key: {
    _id: mongoose.Types.ObjectId;
    label: string;
    prefix: string;
    ipAllowlist?: string[] | null;
    lastUsedAt?: Date | null;
    revokedAt?: Date | null;
    createdAt?: Date | null;
    primaryKey?: boolean;
    isDisabled?: boolean;
  },
  stats?: ApiKeyJobStats,
) {
  const base = {
    id: key._id.toString(),
    label: key.label,
    prefix: key.prefix,
    ipAllowlistCount: (key.ipAllowlist ?? []).length,
    lastUsedAt: key.lastUsedAt ? new Date(key.lastUsedAt).toISOString() : null,
    revokedAt: key.revokedAt ? new Date(key.revokedAt).toISOString() : null,
    createdAt: key.createdAt ? new Date(key.createdAt).toISOString() : null,
  };

  if (stats !== undefined) {
    return {
      ...base,
      ipAllowlist: key.ipAllowlist ?? [],
      primaryKey: Boolean(key.primaryKey),
      isDisabled: Boolean(key.isDisabled),
      stats,
    };
  }

  return {
    ...base,
    primaryKey: Boolean(key.primaryKey),
    isDisabled: Boolean(key.isDisabled),
  };
}

type UsageFacetShape = {
  summary: Array<{
    totalJobs: number;
    completed: number;
    failed: number;
    cancelled: number;
    inFlight: number;
    totalTokens: number;
    lastJobAt: Date | null;
  }>;
  lastJob: Array<{ _id: mongoose.Types.ObjectId }>;
};

async function aggregateUsageSummary(
  userId: mongoose.Types.ObjectId,
  apiKeyOid: mongoose.Types.ObjectId,
): Promise<{
  totalJobs: number;
  completed: number;
  failed: number;
  cancelled: number;
  inFlight: number;
  totalTokens: number;
  lastJobAt: string | null;
  lastJobId: string | null;
}> {
  const emptyFacet: UsageFacetShape = { summary: [], lastJob: [] };
  const agg = (await ChatJobModel.aggregate([
    { $match: { userId, apiKeyId: apiKeyOid } },
    {
      $facet: {
        summary: [
          {
            $group: {
              _id: null,
              totalJobs: { $sum: 1 },
              completed: {
                $sum: {
                  $cond: [{ $in: ["$status", ["completed_partial", "completed_full"]] }, 1, 0],
                },
              },
              failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
              cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
              inFlight: {
                $sum: {
                  $cond: [{ $in: ["$status", ["pending", "queued", "running"]] }, 1, 0],
                },
              },
              totalTokens: { $sum: { $ifNull: ["$result.totalTokens", 0] } },
              lastJobAt: { $max: "$createdAt" },
            },
          },
        ],
        lastJob: [{ $sort: { createdAt: -1 } }, { $limit: 1 }, { $project: { _id: 1 } }],
      },
    },
  ])) as UsageFacetShape[];

  const facet = agg[0] ?? emptyFacet;
  const s = facet.summary[0];
  return {
    totalJobs: s?.totalJobs ?? 0,
    completed: s?.completed ?? 0,
    failed: s?.failed ?? 0,
    cancelled: s?.cancelled ?? 0,
    inFlight: s?.inFlight ?? 0,
    totalTokens: s?.totalTokens ?? 0,
    lastJobAt: s?.lastJobAt ? new Date(s.lastJobAt).toISOString() : null,
    lastJobId: facet.lastJob[0]?._id?.toString() ?? null,
  };
}

async function handleListApiKeys(request: FastifyRequest, reply: FastifyReply) {
  const user = request.bearerUser!;

  const keys = await ApiKeyModel.find({ userId: user._id }).sort({ createdAt: -1 }).lean();
  const keyIds = keys.map((k) => k._id as mongoose.Types.ObjectId);
  const statsByKeyId = await aggregateJobStatsByKeyIds(user._id, keyIds);

  return sendSuccess(reply, {
    keys: keys.map((k) => {
      const id = k._id.toString();
      return toPublicKeyDto(k, statsByKeyId.get(id) ?? { ...EMPTY_JOB_STATS });
    }),
  });
}

async function handleCreateApiKey(request: FastifyRequest, reply: FastifyReply) {
  try {
    const user = request.bearerUser!;
    const body = z
      .object({
        label: z.string().transform((v) => v.trim()),
        ipAllowlist: z.any().optional(),
      })
      .safeParse(request.body);
    if (!body.success) return sendError(reply, "Invalid request body.", 400, "INVALID_BODY");

    const label = body.data.label;
    const ipAllowlist = parseIpAllowlist(body.data.ipAllowlist);
    if (!label) return sendError(reply, "Label is required.", 400, "LABEL_REQUIRED");
    if (label.length > 80) return sendError(reply, "Label is too long.", 400, "LABEL_TOO_LONG");
    const ipError = validateExactIps(ipAllowlist);
    if (ipError) return sendError(reply, ipError, 400, "INVALID_IP");

    const plan = assertActivePlan(user, reply);
    if (!plan) return;

    const enabledKeyCount = await ApiKeyModel.countDocuments({
      userId: user._id,
      revokedAt: null,
      isDisabled: false,
    });

    if (enabledKeyCount >= plan.maxApiKeys) {
      return sendError(
        reply,
        `Plan limit reached: ${plan.name} allows at most ${plan.maxApiKeys} active API key(s). Revoke an existing key or upgrade your plan.`,
        403,
        "API_KEY_LIMIT_REACHED",
      );
    }

    const apiKey = generateApiKey();
    const hashedKey = sha256Hex(apiKey);
    const prefix = apiKey.slice(0, 12);

    const hasAnyKey = await ApiKeyModel.exists({ userId: user._id, revokedAt: null });

    const doc = await ApiKeyModel.create({
      userId: user._id,
      label,
      prefix,
      hashedKey,
      ipAllowlist,
      revokedAt: null,
      lastUsedAt: null,
      primaryKey: !hasAnyKey,
      isDisabled: false,
    });

    await syncUserApiKeysToPlan(user._id);

    const synced = await ApiKeyModel.findById(doc._id).lean();

    return sendSuccess(
      reply,
      {
        apiKey,
        key: toPublicKeyDto({
          ...doc.toObject(),
          primaryKey: Boolean(synced?.primaryKey),
          isDisabled: Boolean(synced?.isDisabled),
        }),
      },
      201,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create API key.";
    return sendError(reply, message, 500, "API_KEY_CREATE_FAILED");
  }
}

async function handlePatchApiKey(request: FastifyRequest, reply: FastifyReply) {
  const user = request.bearerUser!;
  const id = parseApiKeyRouteId(request, reply);
  if (!id) return;

  const parsed = z
    .object({
      ipAllowlist: z.any().optional(),
    })
    .safeParse(request.body ?? {});
  if (!parsed.success) {
    return sendError(reply, "Invalid request body.", 400, "INVALID_BODY");
  }

  if (parsed.data.ipAllowlist === undefined) {
    return sendError(reply, "Provide ipAllowlist.", 400, "NO_UPDATES");
  }

  const doc = await ApiKeyModel.findOne({
    _id: new mongoose.Types.ObjectId(id),
    userId: user._id,
    revokedAt: null,
  });
  if (!doc) return sendError(reply, "API key not found.", 404, "NOT_FOUND");
  if (doc.isDisabled) {
    return sendError(
      reply,
      "This API key is disabled for your current plan.",
      403,
      "API_KEY_DISABLED",
    );
  }

  try {
    const ips = parseIpAllowlist(parsed.data.ipAllowlist);
    const ipErr = validateExactIps(ips);
    if (ipErr) return sendError(reply, ipErr, 400, "INVALID_IP");
    doc.ipAllowlist = ips;
    await doc.save();

    return sendSuccess(reply, {
      key: {
        id: doc._id.toString(),
        label: doc.label,
        prefix: doc.prefix,
        ipAllowlist: doc.ipAllowlist ?? [],
        ipAllowlistCount: (doc.ipAllowlist ?? []).length,
        lastUsedAt: doc.lastUsedAt ? new Date(doc.lastUsedAt).toISOString() : null,
        revokedAt: null,
        createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update API key.";
    return sendError(reply, message, 500, "API_KEY_UPDATE_FAILED");
  }
}

async function handleDeleteApiKey(request: FastifyRequest, reply: FastifyReply) {
  const user = request.bearerUser!;
  const id = parseApiKeyRouteId(request, reply);
  if (!id) return;

  const apiKeyOid = new mongoose.Types.ObjectId(id);
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const existing = await ApiKeyModel.findOne({
        _id: apiKeyOid,
        userId: user._id,
        revokedAt: null,
      }).session(session);

      if (!existing) {
        throw new Error("API_KEY_NOT_FOUND");
      }

      await deleteAllFaqDataForApiKeyInSession(apiKeyOid, user._id, session);

      existing.revokedAt = new Date();
      await existing.save({ session });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "API_KEY_NOT_FOUND") {
      return sendError(reply, "API key not found.", 404, "NOT_FOUND");
    }
    const message = e instanceof Error ? e.message : "Failed to revoke API key.";
    return sendError(reply, message, 500, "API_KEY_REVOKE_FAILED");
  } finally {
    await session.endSession();
  }

  /**
   * Qdrant is outside MongoDB; it cannot join the transaction. Run after commit so Mongo stays authoritative;
   * if this fails, the client gets 500 and can retry (delete is idempotent).
   */
  const qr = await deleteFaqChunkPointsByApiKeyFromQdrant(id);
  if (!qr.skipped && !qr.ok) {
    return sendError(
      reply,
      `API key revoked but vector index cleanup failed: ${qr.error ?? "unknown error"}`,
      500,
      "QDRANT_CLEANUP_FAILED",
    );
  }

  return sendSuccess(reply, { message: "Revoked." });
}

async function handleRotateApiKey(request: FastifyRequest, reply: FastifyReply) {
  const user = request.bearerUser!;
  const id = parseApiKeyRouteId(request, reply);
  if (!id) return;

  const existing = await ApiKeyModel.findOne({
    _id: new mongoose.Types.ObjectId(id),
    userId: user._id,
    revokedAt: null,
  });
  if (!existing) return sendError(reply, "API key not found.", 404, "NOT_FOUND");

  const apiKey = generateApiKey();
  const hashedKey = sha256Hex(apiKey);
  const prefix = apiKey.slice(0, 12);

  existing.revokedAt = new Date();
  await existing.save();

  const replacement = await ApiKeyModel.create({
    userId: user._id,
    label: existing.label,
    prefix,
    hashedKey,
    ipAllowlist: existing.ipAllowlist ?? [],
    revokedAt: null,
    lastUsedAt: null,
    primaryKey: Boolean(existing.primaryKey),
    isDisabled: false,
  });

  await syncUserApiKeysToPlan(user._id);

  const synced = await ApiKeyModel.findById(replacement._id).lean();

  return sendSuccess(reply, {
    apiKey,
    key: toPublicKeyDto({
      ...replacement.toObject(),
      primaryKey: Boolean(synced?.primaryKey),
      isDisabled: Boolean(synced?.isDisabled),
    }),
  });
}

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

  const plan = resolvePlanForUser(user.plan);
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

export async function registerApiKeyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/v1/api-keys", { preHandler: requireBearerUser }, handleListApiKeys);
  fastify.post("/api/v1/api-keys", { preHandler: requireBearerUser }, handleCreateApiKey);
  fastify.patch("/api/v1/api-keys/:id", { preHandler: requireBearerUser }, handlePatchApiKey);
  fastify.delete("/api/v1/api-keys/:id", { preHandler: requireBearerUser }, handleDeleteApiKey);
  fastify.post("/api/v1/api-keys/:id/rotate", { preHandler: requireBearerUser }, handleRotateApiKey);
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
