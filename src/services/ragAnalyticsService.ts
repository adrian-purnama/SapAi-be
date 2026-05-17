import mongoose from "mongoose";

import { FAQ_INTENT_VALUES } from "../constants/faqDocument.js";
import { ChatJobModel } from "../models/ChatJob.js";

const TOP_CATEGORIES = 15;
const WEAK_ANSWERS = 15;

/** Last user `content` in `input` order (same semantics as dashboard extraction). */
const LAST_USER_CONTENT_FROM_INPUT: Record<string, unknown> = {
  $let: {
    vars: {
      userMsgs: {
        $filter: {
          input: { $ifNull: ["$input", []] },
          as: "m",
          cond: { $eq: ["$$m.role", "user"] },
        },
      },
    },
    in: {
      $let: {
        vars: {
          n: { $size: "$$userMsgs" },
        },
        in: {
          $cond: [
            { $gt: ["$$n", 0] },
            {
              $let: {
                vars: { last: { $arrayElemAt: ["$$userMsgs", { $subtract: ["$$n", 1] }] } },
                in: { $ifNull: ["$$last.content", ""] },
              },
            },
            "",
          ],
        },
      },
    },
  },
};

export type RagAnalyticsFilters = {
  from?: Date;
  to?: Date;
  answerable?: string;
  intent?: string;
  /** Exact category label, or `__uncategorized` for null category. */
  category?: string;
};

function buildBaseMatch(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  f: RagAnalyticsFilters,
): Record<string, unknown> {
  const m: Record<string, unknown> = {
    userId,
    apiKeyId,
    taskType: "rag",
  };
  const and: Record<string, unknown>[] = [];

  if (f.from != null || f.to != null) {
    const range: Record<string, Date> = {};
    if (f.from != null) range.$gte = f.from;
    if (f.to != null) range.$lte = f.to;
    m.createdAt = range;
  }

  if (f.answerable?.trim()) {
    m["ragAnalysis.answerable"] = f.answerable.trim();
  }
  if (f.intent?.trim()) {
    m["ragAnalysis.intent"] = f.intent.trim();
  }
  if (f.category?.trim()) {
    const c = f.category.trim();
    if (c === "__uncategorized") {
      and.push({
        $or: [{ "ragAnalysis.category": null }, { "ragAnalysis.category": { $exists: false } }],
      });
    } else {
      m["ragAnalysis.category"] = c;
    }
  }

  if (and.length > 0) {
    m.$and = and;
  }

  return m;
}

function emptyIntentCounts(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k of FAQ_INTENT_VALUES) o[k] = 0;
  return o;
}

export type RagAnalyticsSummary = {
  window: { from: string | null; to: string | null };
  totalRagJobs: number;
  totalWithClassification: number;
  byAnswerable: Record<string, number>;
  byIntent: Record<string, number>;
  topCategories: { category: string; count: number }[];
  weakAnswers: {
    fingerprint: string | null;
    sampleQuestion: string;
    count: number;
    lastAt: string | null;
    sampleJobId: string | null;
  }[];
};

const WEAK_ANSWERABLE_MATCH = { $in: ["no", "unclear"] as const };

export async function getRagAnalyticsSummary(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  filters: RagAnalyticsFilters,
): Promise<RagAnalyticsSummary> {
  const base = buildBaseMatch(userId, apiKeyId, filters);
  const classifiedMatch = { ...base, ragAnalysis: { $ne: null } };

  const totalRagJobs = await ChatJobModel.countDocuments(base);
  const totalWithClassification = await ChatJobModel.countDocuments(classifiedMatch);

  const byAnswerableRows = await ChatJobModel.aggregate<{ _id: string | null; n: number }>([
    { $match: { ...classifiedMatch, "ragAnalysis.answerable": { $nin: [null, ""] } } },
    { $group: { _id: "$ragAnalysis.answerable", n: { $sum: 1 } } },
  ]);
  const byAnswerable: Record<string, number> = {};
  for (const r of byAnswerableRows) {
    if (r._id != null) byAnswerable[String(r._id)] = r.n;
  }

  const byIntentRows = await ChatJobModel.aggregate<{ _id: string | null; n: number }>([
    { $match: { ...classifiedMatch, "ragAnalysis.intent": { $nin: [null, ""] } } },
    { $group: { _id: "$ragAnalysis.intent", n: { $sum: 1 } } },
  ]);
  const byIntent: Record<string, number> = emptyIntentCounts();
  for (const r of byIntentRows) {
    if (r._id != null) {
      const k = String(r._id);
      if (k in byIntent) byIntent[k] = r.n;
      else byIntent[k] = r.n;
    }
  }

  const topCategories = await ChatJobModel.aggregate<{ _id: string | null; n: number }>([
    { $match: classifiedMatch },
    {
      $group: {
        _id: { $ifNull: ["$ragAnalysis.category", "__uncategorized"] },
        n: { $sum: 1 },
      },
    },
    { $sort: { n: -1 } },
    { $limit: TOP_CATEGORIES },
  ]).then((rows) =>
    rows.map((r) => ({
      category: r._id === "__uncategorized" || r._id == null ? "__uncategorized" : String(r._id),
      count: r.n,
    })),
  );

  const weakAnswers = await ChatJobModel.aggregate<{
    _id: string | null;
    n: number;
    sample: string | null;
    lastAt: Date | null;
    sampleJobId: mongoose.Types.ObjectId | null;
  }>([
    {
      $match: {
        ...classifiedMatch,
        "ragAnalysis.answerable": WEAK_ANSWERABLE_MATCH,
      },
    },
    {
      $addFields: {
        _weakTrimmedQ: { $trim: { input: LAST_USER_CONTENT_FROM_INPUT } },
      },
    },
    {
      $addFields: {
        _weakGroupKey: {
          $cond: [
            { $gt: [{ $strLenCP: { $ifNull: ["$_weakTrimmedQ", ""] } }, 0] },
            { $toLower: "$_weakTrimmedQ" },
            { $concat: ["__job_", { $toString: "$_id" }] },
          ],
        },
      },
    },
    {
      $group: {
        _id: "$_weakGroupKey",
        n: { $sum: 1 },
        sample: { $first: "$_weakTrimmedQ" },
        lastAt: { $max: "$createdAt" },
        sampleJobId: { $first: "$_id" },
      },
    },
    { $sort: { n: -1 } },
    { $limit: WEAK_ANSWERS },
  ]).then((rows) =>
    rows.map((r) => ({
      fingerprint: typeof r._id === "string" && r._id.startsWith("__job_") ? null : r._id,
      sampleQuestion: (r.sample && String(r.sample).trim()) || "—",
      count: r.n,
      lastAt: r.lastAt ? new Date(r.lastAt).toISOString() : null,
      sampleJobId: r.sampleJobId ? String(r.sampleJobId) : null,
    })),
  );

  return {
    window: {
      from: filters.from ? filters.from.toISOString() : null,
      to: filters.to ? filters.to.toISOString() : null,
    },
    totalRagJobs,
    totalWithClassification,
    byAnswerable,
    byIntent,
    topCategories,
    weakAnswers,
  };
}

export type RagQueryRow = {
  jobId: string;
  createdAt: string | null;
  question: string | null;
  answerPreview: string | null;
  ragAnalysis: {
    category: string | null;
    answerable: string | null;
    intent: string | null;
  } | null;
  status: string;
  taskType: string;
};

const ANSWER_PREVIEW = 400;

function lastUserQuestionFromInputLean(d: { input?: { role?: string; content?: string }[] }): string | null {
  const input = Array.isArray(d.input) ? d.input : [];
  const lastUser = [...input].reverse().find((m) => m?.role === "user");
  const t = typeof lastUser?.content === "string" ? lastUser.content.trim() : "";
  return t.length > 0 ? t : null;
}

export async function getRagAnalyticsQueries(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  filters: RagAnalyticsFilters,
  page: number,
  limit: number,
): Promise<{ items: RagQueryRow[]; total: number; page: number; limit: number }> {
  const base = buildBaseMatch(userId, apiKeyId, filters);
  const skip = (page - 1) * limit;

  const total = await ChatJobModel.countDocuments(base);
  const docs = await ChatJobModel.find(base)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .select({
      status: 1,
      taskType: 1,
      createdAt: 1,
      input: 1,
      ragAnalysis: 1,
      "result.text": 1,
    })
    .lean();

  const items: RagQueryRow[] = docs.map((d: any) => {
    const text = typeof d.result?.text === "string" ? d.result.text : "";
    const preview =
      text.length > ANSWER_PREVIEW ? `${text.slice(0, ANSWER_PREVIEW - 1)}…` : text || null;
    const ra = d.ragAnalysis;
    return {
      jobId: String(d._id),
      createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
      question: lastUserQuestionFromInputLean(d),
      answerPreview: preview,
      ragAnalysis: ra
        ? {
            category: ra.category ?? null,
            answerable: ra.answerable ?? null,
            intent: ra.intent ?? null,
          }
        : null,
      status: String(d.status ?? ""),
      taskType: String(d.taskType ?? "rag"),
    };
  });

  return { items, total, page, limit };
}

export type ResolveRagGapParams = {
  jobId?: string;
  fingerprint?: string | null;
};

/** Mark weak-gap RAG jobs as answered (`ragAnalysis.answerable` → `yes`) after KB updates. */
export async function resolveRagGap(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  params: ResolveRagGapParams,
): Promise<{ modifiedCount: number }> {
  const weakOnly: Record<string, unknown> = {
    userId,
    apiKeyId,
    taskType: "rag",
    "ragAnalysis.answerable": WEAK_ANSWERABLE_MATCH,
  };

  const fingerprint = params.fingerprint?.trim().toLowerCase();
  if (fingerprint) {
    const jobIds = await ChatJobModel.aggregate<{ _id: mongoose.Types.ObjectId }>([
      { $match: weakOnly },
      { $addFields: { _weakTrimmedQ: { $trim: { input: LAST_USER_CONTENT_FROM_INPUT } } } },
      { $addFields: { _weakGroupKey: { $toLower: "$_weakTrimmedQ" } } },
      { $match: { _weakGroupKey: fingerprint } },
      { $project: { _id: 1 } },
    ]);
    if (jobIds.length === 0) return { modifiedCount: 0 };
    const res = await ChatJobModel.updateMany(
      { _id: { $in: jobIds.map((j) => j._id) } },
      { $set: { "ragAnalysis.answerable": "yes" } },
    );
    return { modifiedCount: res.modifiedCount };
  }

  const jobId = params.jobId?.trim();
  if (jobId && mongoose.isValidObjectId(jobId)) {
    const res = await ChatJobModel.updateMany(
      { ...weakOnly, _id: new mongoose.Types.ObjectId(jobId) },
      { $set: { "ragAnalysis.answerable": "yes" } },
    );
    return { modifiedCount: res.modifiedCount };
  }

  throw new Error("Provide jobId or fingerprint.");
}
