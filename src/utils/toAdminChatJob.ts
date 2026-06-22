import type { Types } from "mongoose";

import { lastUserMessageContent } from "./lastUserMessage.js";

export type AdminChatJobResult = {
  text: string | null;
  json: unknown;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} | null;

export type AdminChatJobRagAnalysis = {
  category: string | null;
  answerable: string | null;
  intent: string | null;
} | null;

export type AdminChatJob = {
  id: string;
  userId: string;
  userEmail: string | null;
  plan: string;
  apiKeyId: string;
  taskType: string;
  status: string;
  model: string;
  maxTokens: number;
  useDeepSeek: boolean | null;
  input: Array<{ role: string; content: string; images?: string[] }>;
  result: AdminChatJobResult;
  ragAnalysis: AdminChatJobRagAnalysis;
  error: { message: string | null; code: string | null } | null;
  attempts: number;
  maxAttempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AdminChatJobSummary = Omit<
  AdminChatJob,
  "input" | "result" | "error" | "ragAnalysis"
> & {
  question: string | null;
  totalTokens: number;
  errorCode: string | null;
  ragAnswerable: string | null;
};

type RagAnalysisLike = {
  category?: string | null;
  answerable?: string | null;
  intent?: string | null;
} | null;

type JobDocLike = {
  _id: Types.ObjectId;
  userId: Types.ObjectId | string;
  plan: string;
  apiKeyId: Types.ObjectId | string;
  status: string;
  taskType: string;
  model: string;
  maxTokens?: number | null;
  useDeepSeek?: boolean | null;
  input?: Array<{ role?: string; content?: string; images?: string[] | null }> | null;
  ragAnalysis?: RagAnalysisLike;
  result?: {
    text?: string | null;
    json?: unknown;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
  } | null;
  error?: { message?: string | null; code?: string | null } | null;
  attempts?: number | null;
  maxAttempts?: number | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

function toIso(d: unknown): string | null {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(String(d));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function mapRagAnalysis(ra: RagAnalysisLike): AdminChatJobRagAnalysis {
  if (!ra || typeof ra !== "object") return null;
  return {
    category: ra.category ?? null,
    answerable: ra.answerable ?? null,
    intent: ra.intent ?? null,
  };
}

function mapResult(r: JobDocLike["result"]): AdminChatJobResult {
  if (!r) return null;
  return {
    text: r.text ?? null,
    json: r.json ?? null,
    promptTokens: r.promptTokens ?? 0,
    completionTokens: r.completionTokens ?? 0,
    totalTokens: r.totalTokens ?? 0,
  };
}

function mapError(e: JobDocLike["error"]): AdminChatJob["error"] {
  if (!e || (e.message == null && e.code == null)) return null;
  return { message: e.message ?? null, code: e.code ?? null };
}

function mapInput(input: JobDocLike["input"]): AdminChatJob["input"] {
  if (!Array.isArray(input)) return [];
  return input.map((m) => {
    const row: AdminChatJob["input"][number] = {
      role: String(m.role ?? ""),
      content: String(m.content ?? ""),
    };
    if (Array.isArray(m.images) && m.images.length > 0) {
      const chars = m.images.reduce((n, img) => n + String(img).length, 0);
      row.images = [`[${m.images.length} image(s), ${chars} base64 chars omitted]`];
    }
    return row;
  });
}

export function toAdminChatJob(doc: JobDocLike, userEmail: string | null = null): AdminChatJob {
  return {
    id: doc._id.toString(),
    userId: String(doc.userId),
    userEmail,
    plan: String(doc.plan),
    apiKeyId: String(doc.apiKeyId),
    taskType: doc.taskType,
    status: doc.status,
    model: doc.model,
    maxTokens: doc.maxTokens ?? 500,
    useDeepSeek: doc.useDeepSeek ?? null,
    input: mapInput(doc.input),
    result: mapResult(doc.result),
    ragAnalysis: mapRagAnalysis(doc.ragAnalysis ?? null),
    error: mapError(doc.error),
    attempts: doc.attempts ?? 0,
    maxAttempts: doc.maxAttempts ?? 3,
    startedAt: toIso(doc.startedAt),
    finishedAt: toIso(doc.finishedAt),
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}

export function toAdminChatJobSummary(doc: JobDocLike, userEmail: string | null = null): AdminChatJobSummary {
  const full = toAdminChatJob(doc, userEmail);
  const { input: _i, result, error, ragAnalysis, ...rest } = full;
  return {
    ...rest,
    question: lastUserMessageContent(doc.input),
    totalTokens: result?.totalTokens ?? 0,
    errorCode: error?.code ?? null,
    ragAnswerable: ragAnalysis?.answerable ?? null,
  };
}
