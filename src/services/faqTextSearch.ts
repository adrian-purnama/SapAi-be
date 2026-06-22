import mongoose from "mongoose";

import { FaqChunkModel } from "../models/FaqChunk.js";
import type { FaqChunkHit } from "../qdrant/faqChunks.js";

export type SearchFaqChunksTextParams = {
  apiKeyId: string;
  query: string;
  limit?: number;
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

function readTextLimit(limit?: number): number {
  const n = limit ?? DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

/** Keyword retrieval over `FaqChunk` rows via MongoDB `$text` search. */
export async function searchFaqChunksText(params: SearchFaqChunksTextParams): Promise<FaqChunkHit[]> {
  const query = params.query.trim();
  if (!query) return [];

  const apiKeyId = params.apiKeyId.trim();
  if (!apiKeyId || !mongoose.isValidObjectId(apiKeyId)) return [];

  const limit = readTextLimit(params.limit);
  const rows = await FaqChunkModel.find(
    {
      $text: { $search: query },
      apiKeyId: new mongoose.Types.ObjectId(apiKeyId),
      isProcessed: true,
    },
    { score: { $meta: "textScore" }, text: 1, faqDocumentId: 1 },
  )
    .sort({ score: { $meta: "textScore" } })
    .limit(limit)
    .lean<Array<{ _id: mongoose.Types.ObjectId; text: string; faqDocumentId: mongoose.Types.ObjectId; score?: number }>>();

  return rows.map((r) => ({
    score: typeof r.score === "number" ? r.score : 0,
    text: r.text.trim(),
    chunkId: String(r._id),
    faqDocumentId: String(r.faqDocumentId),
  }));
}
