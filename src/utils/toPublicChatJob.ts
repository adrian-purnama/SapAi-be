import type { Types } from "mongoose";

import { lastUserMessageContent } from "./lastUserMessage.js";

export type PublicRagAnalysis = {
  category: string | null;
  answerable: string | null;
  intent: string | null;
};

/** Public GET /api/v1/chat/jobs/:id payload   no userId, plan, apiKeyId, input, or attempts. */
export type PublicChatJobResponse = {
  id: string;
  status: string;
  taskType: string;
  model: string;
  maxTokens: number;
  useDeepSeek: boolean | null;
  /** Latest user message derived from `input` (last user role). */
  question: string | null;
  ragAnalysis: PublicRagAnalysis | null;
  result: {
    text: string | null;
    json: unknown;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  error: { message: string | null; code: string | null } | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

type RagAnalysisLike = {
  category?: string | null;
  answerable?: string | null;
  intent?: string | null;
} | null;

type JobDocLike = {
  _id: Types.ObjectId;
  status: string;
  taskType: string;
  model: string;
  maxTokens?: number | null;
  useDeepSeek?: boolean | null;
  input?: Array<{ role?: string; content?: string }> | null;
  ragAnalysis?: RagAnalysisLike;
  result?: {
    text?: string | null;
    json?: unknown;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
  } | null;
  error?: { message?: string | null; code?: string | null } | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

function mapRagAnalysis(ra: RagAnalysisLike): PublicRagAnalysis | null {
  if (!ra || typeof ra !== "object") return null;
  return {
    category: ra.category ?? null,
    answerable: ra.answerable ?? null,
    intent: ra.intent ?? null,
  };
}

export function toPublicChatJob(doc: JobDocLike): PublicChatJobResponse {
  const r = doc.result;
  const question = lastUserMessageContent(doc.input);

  return {
    id: doc._id.toString(),
    status: doc.status,
    taskType: doc.taskType,
    model: doc.model,
    maxTokens: doc.maxTokens ?? 500,
    useDeepSeek: doc.useDeepSeek ?? null,
    question,
    ragAnalysis: mapRagAnalysis(doc.ragAnalysis ?? null),
    result: r
      ? {
          text: r.text ?? null,
          json: r.json ?? null,
          promptTokens: r.promptTokens ?? 0,
          completionTokens: r.completionTokens ?? 0,
          totalTokens: r.totalTokens ?? 0,
        }
      : null,
    error:
      doc.error && (doc.error.message != null || doc.error.code != null)
        ? {
            message: doc.error.message ?? null,
            code: doc.error.code ?? null,
          }
        : null,
    startedAt: doc.startedAt ?? null,
    finishedAt: doc.finishedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
