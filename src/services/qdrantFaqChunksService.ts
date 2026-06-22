import { createHash } from "node:crypto";
import type { QdrantClient } from "@qdrant/js-client-rest";

import {
  getFaqChunksCollectionName,
  getQdrantClient,
  safeQdrantOrigin,
} from "../qdrant/client.js";

const MAX_PAYLOAD_TEXT = 12_000;

export type FaqChunkQdrantPoint = {
  chunkId: string;
  embedding: number[];
  text: string;
  faqDocumentId: string;
  userId: string;
  apiKeyId: string;
};

export type UpsertFaqChunkVectorsOptions = {
  replaceDocumentId?: string;
};

export function faqChunkIdToQdrantPointId(chunkId: string): string {
  const hash = createHash("sha256").update(`faq_chunk:${chunkId}`).digest();
  const bytes = Buffer.alloc(16);
  hash.copy(bytes, 0, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function qdrantErrorDetail(err: unknown): string {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { status?: { error?: string } } }).data;
    const msg = data?.status?.error;
    if (msg) return msg;
  }
  return err instanceof Error ? err.message : String(err);
}

function vectorsConfigSize(
  vectors: { size?: number } | Record<string, { size?: number }> | undefined,
): number | null {
  if (!vectors) return null;
  if ("size" in vectors && typeof vectors.size === "number") return vectors.size;
  const first = Object.values(vectors)[0];
  return first && typeof first.size === "number" ? first.size : null;
}

async function readCollectionVectorSize(
  client: QdrantClient,
  collection: string,
): Promise<number | null> {
  const { exists } = await client.collectionExists(collection);
  if (!exists) return null;
  const info = await client.getCollection(collection);
  return vectorsConfigSize(info.config?.params?.vectors as Parameters<typeof vectorsConfigSize>[0]);
}

export class QdrantVectorDimensionMismatchError extends Error {
  readonly collection: string;
  readonly expectedSize: number;
  readonly actualSize: number;
  readonly pointCount: number;

  constructor(params: {
    collection: string;
    expectedSize: number;
    actualSize: number;
    pointCount: number;
  }) {
    super(
      `Qdrant collection "${params.collection}" expects ${params.expectedSize}-dimensional vectors ` +
        `but embeddings are ${params.actualSize}-dimensional (${params.pointCount} points already stored). ` +
        `Delete the collection in Qdrant (Dashboard → Collections → delete "${params.collection}") ` +
        `or set QDRANT_FAQ_COLLECTION to a new name, then re-upload or Rechunk.`,
    );
    this.name = "QdrantVectorDimensionMismatchError";
    this.collection = params.collection;
    this.expectedSize = params.expectedSize;
    this.actualSize = params.actualSize;
    this.pointCount = params.pointCount;
  }
}

async function ensurePayloadKeywordIndex(
  client: QdrantClient,
  collection: string,
  fieldName: string,
): Promise<boolean> {
  try {
    await client.createPayloadIndex(collection, {
      field_name: fieldName,
      field_schema: "keyword",
      wait: true,
    });
    return true;
  } catch (e) {
    const detail = qdrantErrorDetail(e);
    if (/already|exist|duplicate|does not differ|same parameters/i.test(detail)) {
      return true;
    }
    return false;
  }
}

async function ensureFaqDocumentIdKeywordIndex(
  client: QdrantClient,
  collection: string,
): Promise<boolean> {
  return ensurePayloadKeywordIndex(client, collection, "faq_document_id");
}

async function ensureApiKeyIdKeywordIndex(
  client: QdrantClient,
  collection: string,
): Promise<boolean> {
  return ensurePayloadKeywordIndex(client, collection, "api_key_id");
}

async function ensureCollection(client: QdrantClient, collection: string, vectorSize: number): Promise<void> {
  const { exists } = await client.collectionExists(collection);
  if (exists) {
    const existingSize = await readCollectionVectorSize(client, collection);
    if (existingSize !== null && existingSize !== vectorSize) {
      const { count } = await client.count(collection, { exact: true });
      if (count === 0) {
        console.warn("[qdrantFaqChunksService] recreating empty collection for new embedding size", {
          collection,
          from: existingSize,
          to: vectorSize,
        });
        await client.deleteCollection(collection);
      } else {
        throw new QdrantVectorDimensionMismatchError({
          collection,
          expectedSize: existingSize,
          actualSize: vectorSize,
          pointCount: count,
        });
      }
    } else {
      return;
    }
  }

  await client.createCollection(collection, {
    vectors: { size: vectorSize, distance: "Cosine" },
  });
  await ensureFaqDocumentIdKeywordIndex(client, collection);
}

export async function upsertFaqChunkVectors(
  points: FaqChunkQdrantPoint[],
  opts: UpsertFaqChunkVectorsOptions = {},
): Promise<{ upserted: number; skipped: boolean; error?: string }> {
  if (points.length === 0) return { upserted: 0, skipped: false };

  const client = getQdrantClient();
  if (!client) return { upserted: 0, skipped: true };

  const collection = getFaqChunksCollectionName();
  const dim = points[0]!.embedding.length;
  if (!points.every((p) => p.embedding.length === dim)) {
    return { upserted: 0, skipped: false, error: "Mixed embedding dimensions in batch." };
  }

  try {
    await ensureCollection(client, collection, dim);

    const docId = opts.replaceDocumentId?.trim();
    if (docId) {
      const indexOk = await ensureFaqDocumentIdKeywordIndex(client, collection);
      if (indexOk) {
        await client.delete(collection, {
          wait: true,
          filter: { must: [{ key: "faq_document_id", match: { value: docId } }] },
        });
      }
    }

    await client.upsert(collection, {
      wait: true,
      points: points.map((p) => ({
        id: faqChunkIdToQdrantPointId(p.chunkId),
        vector: p.embedding,
        payload: {
          chunk_id: p.chunkId,
          faq_document_id: p.faqDocumentId,
          user_id: p.userId,
          api_key_id: p.apiKeyId,
          text: p.text.slice(0, MAX_PAYLOAD_TEXT),
        },
      })),
    });

    return { upserted: points.length, skipped: false };
  } catch (e) {
    const detail = qdrantErrorDetail(e);
    const message =
      e instanceof QdrantVectorDimensionMismatchError
        ? e.message
        : /expected dim|vector dimension|dimension/i.test(detail)
          ? `${detail}. This usually means the Qdrant collection was created for a different embedding model   delete collection "${collection}" or change QDRANT_FAQ_COLLECTION, then Rechunk.`
          : detail || "Qdrant upsert failed.";
    console.error("[qdrantFaqChunksService] upsert error", {
      message,
      detail,
      vectorDim: dim,
      origin: safeQdrantOrigin(process.env.QDRANT_URL?.trim() ?? ""),
      hasApiKey: Boolean(process.env.QDRANT_API_KEY?.trim()),
    });
    return { upserted: 0, skipped: false, error: message };
  }
}

export async function deleteFaqDocumentPointsFromQdrant(
  faqDocumentId: string,
): Promise<{ ok: boolean; skipped: boolean; error?: string }> {
  const docId = faqDocumentId.trim();
  if (!docId) return { ok: false, skipped: true };

  const client = getQdrantClient();
  if (!client) return { ok: false, skipped: true };

  const collection = getFaqChunksCollectionName();
  try {
    const { exists } = await client.collectionExists(collection);
    if (!exists) return { ok: false, skipped: true };

    const indexOk = await ensureFaqDocumentIdKeywordIndex(client, collection);
    if (!indexOk) {
      return {
        ok: false,
        skipped: false,
        error: "Cannot delete from Qdrant: keyword index on faq_document_id is required.",
      };
    }

    await client.delete(collection, {
      wait: true,
      filter: { must: [{ key: "faq_document_id", match: { value: docId } }] },
    });
    return { ok: true, skipped: false };
  } catch (e) {
    const message = qdrantErrorDetail(e);
    return { ok: false, skipped: false, error: message };
  }
}

/** Removes all FAQ chunk vectors whose payload `api_key_id` matches (e.g. when revoking a project API key). */
export async function deleteFaqChunkPointsByApiKeyFromQdrant(
  apiKeyId: string,
): Promise<{ ok: boolean; skipped: boolean; error?: string }> {
  const id = apiKeyId.trim();
  if (!id) return { ok: false, skipped: true };

  const client = getQdrantClient();
  if (!client) return { ok: false, skipped: true };

  const collection = getFaqChunksCollectionName();
  try {
    const { exists } = await client.collectionExists(collection);
    if (!exists) return { ok: false, skipped: true };

    const indexOk = await ensureApiKeyIdKeywordIndex(client, collection);
    if (!indexOk) {
      return {
        ok: false,
        skipped: false,
        error: "Cannot delete from Qdrant: keyword index on api_key_id is required.",
      };
    }

    await client.delete(collection, {
      wait: true,
      filter: { must: [{ key: "api_key_id", match: { value: id } }] },
    });
    return { ok: true, skipped: false };
  } catch (e) {
    const message = qdrantErrorDetail(e);
    return { ok: false, skipped: false, error: message };
  }
}

