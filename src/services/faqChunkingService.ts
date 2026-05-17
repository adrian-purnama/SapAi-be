import mongoose from "mongoose";

import { FAQ_ALLOWED_EXTENSION } from "../constants/faqDocument.js";
import {
  callOllamaEmbed,
  readOllamaEmbedMaxChars,
  readOllamaEmbedModel,
} from "../ollama/callOllamaEmbed.js";
import { FaqChunkModel } from "../models/FaqChunk.js";
import { FaqDocumentModel } from "../models/FaqDocument.js";
import { upsertFaqChunkVectors, type FaqChunkQdrantPoint } from "./qdrantFaqChunksService.js";

/** Hard ceiling for stored FAQ chunk text (`FAQ_CHUNK_MAX_CHARS` env). */
export const FAQ_CHUNK_MAX_CHARS_CEILING = 8000;

const DEFAULT_FAQ_CHUNK_MAX_CHARS = 1200;

export function readFaqChunkMaxChars(): number {
  const raw = process.env.FAQ_CHUNK_MAX_CHARS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 100) {
      return Math.min(n, FAQ_CHUNK_MAX_CHARS_CEILING);
    }
  }
  return DEFAULT_FAQ_CHUNK_MAX_CHARS;
}

export function readFaqChunkOverlap(): number {
  const maxChars = readFaqChunkMaxChars();
  const raw = process.env.FAQ_CHUNK_OVERLAP?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0 && n < maxChars) return n;
  }
  return Math.min(200, Math.max(0, Math.floor(maxChars / 8)));
}

const DEFAULT_FAQ_CHUNK_INSERT_BATCH = 50;
const DEFAULT_FAQ_EMBED_BATCH_SIZE = 8;

export function readFaqChunkInsertBatchSize(): number {
  const raw = process.env.FAQ_CHUNK_INSERT_BATCH?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 10 && n <= 500) return n;
  }
  return DEFAULT_FAQ_CHUNK_INSERT_BATCH;
}

export function readFaqEmbedBatchSize(): number {
  const raw = process.env.FAQ_EMBED_BATCH_SIZE?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 32) return n;
  }
  return DEFAULT_FAQ_EMBED_BATCH_SIZE;
}

function extFromFilename(filename: string): string {
  const i = filename.lastIndexOf(".");
  if (i < 0) return "";
  return filename.slice(i).toLowerCase();
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

const LEGACY_UNSUPPORTED_MESSAGE =
  "This file type is no longer supported. Upload Markdown (.md) only — copy or export your content as UTF-8 text.";

export function chunkPlainText(
  text: string,
  maxChars = readFaqChunkMaxChars(),
  overlap = readFaqChunkOverlap(),
): string[] {
  const t = text.trim();
  if (!t) return [];
  if (maxChars < 100) return [t];
  const step = Math.max(1, maxChars - overlap);
  const chunks: string[] = [];
  let i = 0;
  while (i < t.length) {
    const slice = t.slice(i, i + maxChars).trim();
    if (slice.length > 0) chunks.push(slice);
    if (i + maxChars >= t.length) break;
    i += step;
    if (chunks.length > 5000) break;
  }
  return chunks;
}

async function extractPlainText(
  buffer: Buffer,
  contentType: string,
  filename: string,
): Promise<{ text: string } | { error: string }> {
  const mime = (contentType || "").split(";")[0]?.trim().toLowerCase() || "";
  const ext = extFromFilename(filename || "");

  if (ext !== FAQ_ALLOWED_EXTENSION) {
    if (mime === "application/pdf" || ext === ".pdf") {
      return {
        error:
          "PDF uploads are no longer supported. Save or export your document as Markdown (.md) and upload again.",
      };
    }
    return { error: LEGACY_UNSUPPORTED_MESSAGE };
  }

  try {
    return { text: normalizeWhitespace(buffer.toString("utf8")) };
  } catch (e) {
    const raw = e instanceof Error ? e.message : "Text extraction failed.";
    return { error: raw };
  }
}

export type RebuildFaqChunksParams = {
  faqDocumentId: string;
  userId: mongoose.Types.ObjectId;
  apiKeyId: mongoose.Types.ObjectId;
  buffer: Buffer;
  contentType: string;
  originalFilename: string;
  /** When set, skips a second parse (same normalized text as {@link validateFaqDocumentExtractable}). */
  preExtractedText?: string;
};

export type RebuildFaqChunksResult = {
  chunkCount: number;
  chunkIds: string[];
  extractionError?: string;
};

export type ValidateFaqExtractResult =
  | { ok: true; normalizedText: string }
  | { ok: false; error: string };

/**
 * Run the same extraction used for chunking. Call before persisting uploads so broken PDFs are rejected with 400
 * instead of storing unusable GridFS files.
 */
export async function validateFaqDocumentExtractable(
  buffer: Buffer,
  contentType: string,
  originalFilename: string,
): Promise<ValidateFaqExtractResult> {
  const extracted = await extractPlainText(buffer, contentType, originalFilename);
  if ("error" in extracted) {
    return { ok: false, error: extracted.error };
  }

  const chunks = chunkPlainText(extracted.text, readFaqChunkMaxChars(), readFaqChunkOverlap());
  if (chunks.length === 0) {
    return {
      ok: false,
      error:
        "No extractable text was found in this file. It may be image-only, blank, or not readable as plain text.",
    };
  }

  return { ok: true, normalizedText: extracted.text };
}

export async function rebuildFaqChunks(params: RebuildFaqChunksParams): Promise<RebuildFaqChunksResult> {
  const faqDocOid = new mongoose.Types.ObjectId(params.faqDocumentId);

  const extracted =
    typeof params.preExtractedText === "string"
      ? { text: params.preExtractedText }
      : await extractPlainText(params.buffer, params.contentType, params.originalFilename);
  if ("error" in extracted) {
    await FaqChunkModel.deleteMany({ faqDocumentId: faqDocOid });
    await FaqDocumentModel.updateOne(
      { _id: faqDocOid },
      { $set: { chunk: { totalChunks: 0, processedChunks: 0 }, isProcessed: false } },
    );
    return { chunkCount: 0, chunkIds: [], extractionError: extracted.error };
  }

  const chunks = chunkPlainText(extracted.text, readFaqChunkMaxChars(), readFaqChunkOverlap());
  await FaqChunkModel.deleteMany({ faqDocumentId: faqDocOid });

  if (chunks.length === 0) {
    await FaqDocumentModel.updateOne(
      { _id: faqDocOid },
      { $set: { chunk: { totalChunks: 0, processedChunks: 0 }, isProcessed: false } },
    );
    return { chunkCount: 0, chunkIds: [] };
  }

  await FaqDocumentModel.updateOne(
    { _id: faqDocOid },
    {
      $set: {
        chunk: { totalChunks: chunks.length, processedChunks: 0 },
        isProcessed: false,
        processingUpdatedAt: new Date(),
      },
    },
  );

  const insertBatch = readFaqChunkInsertBatchSize();
  const chunkIds: string[] = [];
  for (let offset = 0; offset < chunks.length; offset += insertBatch) {
    const slice = chunks.slice(offset, offset + insertBatch);
    const inserted = await FaqChunkModel.insertMany(
      slice.map((text, j) => ({
        faqDocumentId: faqDocOid,
        userId: params.userId,
        apiKeyId: params.apiKeyId,
        chunkIndex: offset + j,
        text,
      })),
    );
    chunkIds.push(...inserted.map((doc) => doc._id.toString()));
  }

  return { chunkCount: chunks.length, chunkIds };
}

export type ChunkEmbeddingVector = {
  chunkId: string;
  embedding: number[];
  model?: string;
};

export type ChunkEmbeddingPipelineResult = {
  processed: number;
  failed: number;
  errors: string[];
  vectors: ChunkEmbeddingVector[];
  qdrant?: { upserted: number; skipped: boolean; error?: string };
};

export type ChunkEmbeddingPipelineOptions = {
  faqDocumentId?: string;
  /** When true, skip Qdrant upsert and Mongo progress unless every chunk embeds successfully. */
  allOrNothing?: boolean;
};

async function syncFaqDocumentChunkProgress(docOid: mongoose.Types.ObjectId): Promise<{
  totalChunks: number;
  processedChunks: number;
  isDocumentComplete: boolean;
}> {
  const totalChunks = await FaqChunkModel.countDocuments({ faqDocumentId: docOid });
  const processedChunks = await FaqChunkModel.countDocuments({ faqDocumentId: docOid, isProcessed: true });
  const isDocumentComplete = totalChunks > 0 && processedChunks === totalChunks;
  await FaqDocumentModel.updateOne(
    { _id: docOid },
    {
      $set: {
        chunk: { totalChunks, processedChunks },
        isProcessed: isDocumentComplete,
        processingUpdatedAt: new Date(),
      },
    },
  );
  return { totalChunks, processedChunks, isDocumentComplete };
}

/** Checkpoint: mark one chunk embedded + refresh document `processedChunks` / `totalChunks`. */
export async function markFaqChunkIndexed(
  chunkId: string,
  faqDocumentId: string,
  embeddingModel: string | null,
): Promise<{ processedChunks: number; totalChunks: number }> {
  if (!mongoose.isValidObjectId(chunkId) || !mongoose.isValidObjectId(faqDocumentId)) {
    return { processedChunks: 0, totalChunks: 0 };
  }

  const docOid = new mongoose.Types.ObjectId(faqDocumentId);
  const chunkOid = new mongoose.Types.ObjectId(chunkId);
  const setChunk: { isProcessed: boolean; embeddingModel?: string } = { isProcessed: true };
  const resolved = embeddingModel?.trim();
  if (resolved) setChunk.embeddingModel = resolved;

  await FaqChunkModel.updateOne({ _id: chunkOid, faqDocumentId: docOid }, { $set: setChunk });
  const progress = await syncFaqDocumentChunkProgress(docOid);
  return { processedChunks: progress.processedChunks, totalChunks: progress.totalChunks };
}

export type ProcessFaqChunksCheckpointResult = {
  processed: number;
  failed: number;
  errors: string[];
  qdrantUpserted: number;
};

function readOllamaBaseUrl(): string {
  return process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434";
}

function splitTextForEmbed(text: string, maxChars: number): string[] {
  const t = text.trim();
  if (t.length <= maxChars) return [t];
  const overlap = Math.min(40, Math.floor(maxChars / 8));
  const step = Math.max(1, maxChars - overlap);
  const parts: string[] = [];
  for (let i = 0; i < t.length; i += step) {
    const slice = t.slice(i, i + maxChars).trim();
    if (slice.length > 0) parts.push(slice);
    if (i + maxChars >= t.length) break;
    if (parts.length > 200) break;
  }
  return parts;
}

function averageEmbeddings(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0) return [];
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i]! += v[i]!;
  }
  const n = vectors.filter((v) => v.length === dim).length || 1;
  for (let i = 0; i < dim; i++) out[i]! /= n;
  return out;
}

async function embedChunkText(text: string): Promise<{ embedding: number[]; model: string }> {
  const maxChars = readOllamaEmbedMaxChars();
  const parts = splitTextForEmbed(text, maxChars);
  const res = await callOllamaEmbed({
    baseUrl: readOllamaBaseUrl(),
    model: readOllamaEmbedModel(),
    input: parts.length === 1 ? parts[0]! : parts,
  });
  if (!res.embeddings.length) {
    throw new Error("Ollama embed returned no vectors.");
  }
  const embedding =
    res.embeddings.length === 1 ? res.embeddings[0]! : averageEmbeddings(res.embeddings);
  if (!embedding.length) {
    throw new Error("Ollama embed returned empty vectors.");
  }
  return { embedding, model: res.model };
}

type ChunkRowForEmbed = {
  _id: mongoose.Types.ObjectId;
  text: string;
  faqDocumentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  apiKeyId: mongoose.Types.ObjectId;
};

async function embedChunkRowsBatch(
  rows: ChunkRowForEmbed[],
): Promise<
  | { ok: true; points: FaqChunkQdrantPoint[]; model: string }
  | { ok: false; errors: string[] }
> {
  const maxChars = readOllamaEmbedMaxChars();
  const flatInputs: string[] = [];
  const spans: { rowIndex: number; partStart: number; partCount: number }[] = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const text = rows[rowIndex]!.text.trim();
    const parts = splitTextForEmbed(text, maxChars);
    spans.push({ rowIndex, partStart: flatInputs.length, partCount: parts.length });
    flatInputs.push(...parts);
  }

  if (flatInputs.length === 0) {
    return { ok: false, errors: rows.map((r) => `Chunk ${r._id}: empty text.`) };
  }

  const res = await callOllamaEmbed({
    baseUrl: readOllamaBaseUrl(),
    model: readOllamaEmbedModel(),
    input: flatInputs.length === 1 ? flatInputs[0]! : flatInputs,
  });

  if (res.embeddings.length !== flatInputs.length) {
    throw new Error(
      `Ollama embed returned ${res.embeddings.length} vectors for ${flatInputs.length} inputs.`,
    );
  }

  const points: FaqChunkQdrantPoint[] = [];
  const errors: string[] = [];

  for (const span of spans) {
    const row = rows[span.rowIndex]!;
    const slice = res.embeddings.slice(span.partStart, span.partStart + span.partCount);
    const embedding = slice.length === 1 ? slice[0]! : averageEmbeddings(slice);
    if (!embedding.length) {
      errors.push(`Chunk ${row._id}: empty embedding.`);
      continue;
    }
    points.push({
      chunkId: row._id.toString(),
      embedding,
      text: row.text,
      faqDocumentId: String(row.faqDocumentId),
      userId: String(row.userId),
      apiKeyId: String(row.apiKeyId),
    });
  }

  if (points.length === 0) {
    return { ok: false, errors };
  }

  return { ok: true, points, model: res.model };
}

/**
 * Batched embed → Qdrant → checkpoint per chunk. Survives partial failure.
 */
export async function processFaqChunksWithCheckpoints(
  chunkIds: string[],
  faqDocumentId: string,
): Promise<ProcessFaqChunksCheckpointResult> {
  if (chunkIds.length === 0) {
    return { processed: 0, failed: 0, errors: [], qdrantUpserted: 0 };
  }

  const docOid = new mongoose.Types.ObjectId(faqDocumentId);
  const errors: string[] = [];
  let processed = 0;
  let qdrantUpserted = 0;

  await FaqChunkModel.updateMany(
    { faqDocumentId: docOid },
    { $set: { isProcessed: false }, $unset: { embeddingModel: "" } },
  );

  const chunkDocs = await FaqChunkModel.find({ faqDocumentId: docOid }).sort({ chunkIndex: 1 }).lean();
  const total = chunkDocs.length;
  const embedBatch = readFaqEmbedBatchSize();

  for (let offset = 0; offset < chunkDocs.length; offset += embedBatch) {
    const batch = chunkDocs.slice(offset, offset + embedBatch);
    const rows: ChunkRowForEmbed[] = [];

    for (const chunk of batch) {
      const text = chunk.text?.trim();
      if (!text) {
        errors.push(`Chunk ${chunk._id}: empty text.`);
        continue;
      }
      rows.push({
        _id: chunk._id as mongoose.Types.ObjectId,
        text,
        faqDocumentId: chunk.faqDocumentId as mongoose.Types.ObjectId,
        userId: chunk.userId as mongoose.Types.ObjectId,
        apiKeyId: chunk.apiKeyId as mongoose.Types.ObjectId,
      });
    }

    if (rows.length === 0) continue;

    try {
      const embedded = await embedChunkRowsBatch(rows);
      if (!embedded.ok) {
        errors.push(...embedded.errors);
        continue;
      }

      const qr = await upsertFaqChunkVectors(embedded.points);
      if (qr.skipped) {
        errors.push("Qdrant is not configured (QDRANT_URL missing).");
        break;
      }
      if (qr.error) {
        errors.push(`Qdrant: ${qr.error}`);
        break;
      }

      qdrantUpserted += qr.upserted;
      for (const point of embedded.points) {
        await markFaqChunkIndexed(point.chunkId, faqDocumentId, embedded.model);
        processed += 1;
      }

      console.info("[faqChunkingService] embed batch checkpoint", {
        faqDocumentId,
        batchEnd: Math.min(offset + embedBatch, total),
        total,
        processed,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Embed or index failed.";
      for (const row of rows) {
        errors.push(`Chunk ${row._id}: ${message}`);
      }
    }
  }

  return {
    processed,
    failed: total - processed,
    errors,
    qdrantUpserted,
  };
}

export async function chunkEmbeddingPipeline(
  chunkIds: string[],
  options?: ChunkEmbeddingPipelineOptions,
): Promise<ChunkEmbeddingPipelineResult> {
  if (chunkIds.length === 0) return { processed: 0, failed: 0, errors: [], vectors: [] };

  const errors: string[] = [];
  const vectors: ChunkEmbeddingVector[] = [];
  const qdrantPoints: FaqChunkQdrantPoint[] = [];
  let processed = 0;
  /** Resolved model string from Ollama embed response (same as requested tag/version identity). */
  let resolvedEmbeddingModel: string | null = null;

  for (const chunkId of chunkIds) {
    const chunk = await FaqChunkModel.findById(chunkId).lean();
    const text = chunk?.text?.trim();
    if (!chunk || !text) {
      errors.push(`Chunk ${chunkId}: not found or empty text.`);
      continue;
    }

    try {
      const { embedding: row, model } = await embedChunkText(text);

      vectors.push({ chunkId, embedding: row, model });
      const label = typeof model === "string" && model.trim() !== "" ? model.trim() : null;
      if (label) resolvedEmbeddingModel = label;
      qdrantPoints.push({
        chunkId,
        embedding: row,
        text,
        faqDocumentId: String(chunk.faqDocumentId),
        userId: String(chunk.userId),
        apiKeyId: String(chunk.apiKeyId),
      });
      processed += 1;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Embed failed.";
      errors.push(`Chunk ${chunkId}: ${message}`);
    }
  }

  const allOrNothing = Boolean(options?.allOrNothing);
  const totalExpected = chunkIds.length;
  const failed = chunkIds.length - processed;
  const embedComplete = processed === totalExpected && failed === 0;

  let qdrant: ChunkEmbeddingPipelineResult["qdrant"] | undefined;
  if (qdrantPoints.length > 0) {
    const shouldUpsert = !allOrNothing || embedComplete;
    if (shouldUpsert) {
      const qr = await upsertFaqChunkVectors(qdrantPoints, {
        replaceDocumentId: allOrNothing ? undefined : options?.faqDocumentId,
      });
      qdrant = { upserted: qr.upserted, skipped: qr.skipped, ...(qr.error ? { error: qr.error } : {}) };
      if (qr.skipped) {
        errors.push("Qdrant: vector store is not configured (QDRANT_URL missing).");
      } else if (qr.error) {
        errors.push(`Qdrant: ${qr.error}`);
      }
    }
  } else if (allOrNothing && totalExpected > 0 && embedComplete) {
    errors.push("Qdrant: no vectors to upload.");
  }

  const successChunkIds = vectors.map((v) => v.chunkId);
  let docIdForProgress = options?.faqDocumentId?.trim() ?? "";
  if (!docIdForProgress && successChunkIds[0]) {
    const row = await FaqChunkModel.findById(successChunkIds[0]).select("faqDocumentId").lean();
    if (row?.faqDocumentId) docIdForProgress = String(row.faqDocumentId);
  }

  const qdrantOk = !qdrant || (!qdrant.error && !qdrant.skipped);
  const mayPersist =
    successChunkIds.length > 0 &&
    docIdForProgress &&
    mongoose.isValidObjectId(docIdForProgress) &&
    qdrantOk &&
    (!allOrNothing || embedComplete);

  if (mayPersist) {
    for (const id of successChunkIds) {
      await markFaqChunkIndexed(id, docIdForProgress, resolvedEmbeddingModel);
    }
  }

  return {
    processed,
    failed,
    errors,
    vectors,
    ...(qdrant ? { qdrant } : {}),
  };
}

