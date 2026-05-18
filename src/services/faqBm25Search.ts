import mongoose from "mongoose";
import MiniSearch from "minisearch";

import { FaqChunkModel } from "../models/FaqChunk.js";
import type { FaqChunkHit } from "../qdrant/faqChunks.js";

export type SearchFaqChunksBm25Params = {
  apiKeyId: string;
  query: string;
  limit?: number;
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
/** Cap corpus size per project to keep query latency predictable. */
const MAX_CORPUS_CHUNKS = 10_000;

function readBm25Limit(limit?: number): number {
  const n = limit ?? DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

type ChunkRow = {
  _id: mongoose.Types.ObjectId;
  text: string;
  faqDocumentId: mongoose.Types.ObjectId;
};

/**
 * Keyword retrieval over `FaqChunk` rows for a project (`apiKeyId`).
 * Uses MiniSearch (BM25-style scoring) over in-memory corpus loaded from Mongo.
 */
export async function searchFaqChunksBm25(params: SearchFaqChunksBm25Params): Promise<FaqChunkHit[]> {
  const query = params.query.trim();
  if (!query) return [];

  const apiKeyId = params.apiKeyId.trim();
  if (!apiKeyId || !mongoose.isValidObjectId(apiKeyId)) return [];

  const apiKeyOid = new mongoose.Types.ObjectId(apiKeyId);
  const rows = await FaqChunkModel.find({
    apiKeyId: apiKeyOid,
    isProcessed: true,
    text: { $exists: true, $ne: "" },
  })
    .select({ text: 1, faqDocumentId: 1 })
    .limit(MAX_CORPUS_CHUNKS)
    .lean<ChunkRow[]>();

  if (rows.length === 0) return [];

  const mini = new MiniSearch({
    idField: "id",
    fields: ["text"],
    storeFields: ["text", "faqDocumentId"],
    searchOptions: {
      boost: { text: 2 },
      fuzzy: 0.15,
      prefix: true,
    },
  });

  mini.addAll(
    rows.map((r) => ({
      id: String(r._id),
      text: r.text.trim(),
      faqDocumentId: String(r.faqDocumentId),
    })),
  );

  const limit = readBm25Limit(params.limit);
  const results = mini.search(query, { boost: { text: 2 }, fuzzy: 0.15, prefix: true });

  return results.slice(0, limit).map((hit) => ({
    score: hit.score,
    text: typeof hit.text === "string" ? hit.text : "",
    chunkId: String(hit.id),
    faqDocumentId: typeof hit.faqDocumentId === "string" ? hit.faqDocumentId : undefined,
  }));
}
