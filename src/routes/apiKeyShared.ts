import type { FastifyReply, FastifyRequest } from "fastify";
import mongoose from "mongoose";

import { FAQ_ANSWERABLE_VALUES, FAQ_INTENT_VALUES } from "../constants/faqDocument.js";
import { ApiKeyModel } from "../models/ApiKey.js";
import type { UserDocument } from "../models/User.js";
import { ChatJobModel } from "../models/ChatJob.js";
import type { RagAnalyticsFilters } from "../services/ragAnalyticsService.js";
import { resolveEffectivePlanForUser, type PlanSnapshot } from "../services/planRegistry.js";
import { sendError } from "../utils/apiResponse.js";

export type ApiKeyJobStats = {
  totalJobs: number;
  completed: number;
  failed: number;
  cancelled: number;
  inFlight: number;
  totalTokens: number;
  lastJobAt: string | null;
};

export const EMPTY_JOB_STATS: ApiKeyJobStats = {
  totalJobs: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  inFlight: 0,
  totalTokens: 0,
  lastJobAt: null,
};

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

export function parseApiKeyRouteId(request: FastifyRequest, reply: FastifyReply): string | null {
  const id = String((request.params as { id?: string })?.id ?? "");
  if (!mongoose.isValidObjectId(id)) {
    sendError(reply, "Invalid key id.", 400, "INVALID_ID");
    return null;
  }
  return id;
}

export function assertActivePlan(user: UserDocument, reply: FastifyReply): PlanSnapshot | null {
  const plan = resolveEffectivePlanForUser(user);
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

export async function loadOwnedApiKeyLean(userId: mongoose.Types.ObjectId, id: string) {
  return ApiKeyModel.findOne({ _id: new mongoose.Types.ObjectId(id), userId }).lean();
}

export function parseRagAnalyticsFiltersFromQuery(q: Record<string, unknown>): RagAnalyticsFilters {
  return {
    from: parseIsoDate(String(q.from ?? "")),
    to: parseIsoDate(String(q.to ?? "")),
    answerable: validateOptionalEnum(String(q.answerable ?? ""), FAQ_ANSWERABLE_VALUES),
    intent: validateOptionalEnum(String(q.intent ?? ""), FAQ_INTENT_VALUES),
    category: String(q.category ?? "").trim() || undefined,
  };
}

export function mergeRagFiltersIntoJobMatch(jobMatch: Record<string, unknown>, rf: RagAnalyticsFilters): void {
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

export async function assertRagAnalyticsAccess(
  user: UserDocument,
  id: string,
  reply: FastifyReply,
): Promise<{ plan: PlanSnapshot; apiKeyOid: mongoose.Types.ObjectId } | null> {
  const key = await loadOwnedApiKeyLean(user._id, id);
  if (!key) {
    sendError(reply, "API key not found.", 404, "NOT_FOUND");
    return null;
  }

  const plan = resolveEffectivePlanForUser(user);
  if (!plan) {
    sendError(reply, "No subscription plan is assigned to this account.", 403, "NO_PLAN");
    return null;
  }
  if (!plan.ragAnalyticsEnabled) {
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

export async function aggregateJobStatsByKeyIds(
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

export function toPublicKeyDto(
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

export async function aggregateUsageSummary(
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
