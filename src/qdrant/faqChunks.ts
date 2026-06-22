import { getQdrantContext } from "./client.js";

export type SearchFaqChunksParams = {
  apiKeyId: string;
  vector: number[];
  limit?: number;
};

export type FaqChunkHit = {
  score: number;
  text: string;
  chunkId?: string;
  faqDocumentId?: string;
};

export async function searchFaqChunks(params: SearchFaqChunksParams): Promise<FaqChunkHit[]> {
  const ctx = getQdrantContext();
  if (!ctx) return [];

  const limit = Math.min(Math.max(params.limit ?? 5, 1), 20);
  const res = await ctx.client.search(ctx.collection, {
    vector: params.vector,
    limit,
    with_payload: true,
    with_vector: false,
    filter: {
      must: [{ key: "api_key_id", match: { value: params.apiKeyId } }],
    },
  });

  return res
    .map((p) => {
      const payload = (p.payload ?? {}) as {
        text?: unknown;
        chunk_id?: unknown;
        faq_document_id?: unknown;
      };
      return {
        score: typeof p.score === "number" ? p.score : 0,
        text: typeof payload.text === "string" ? payload.text : "",
        chunkId: typeof payload.chunk_id === "string" ? payload.chunk_id : undefined,
        faqDocumentId:
          typeof payload.faq_document_id === "string" ? payload.faq_document_id : undefined,
      } satisfies FaqChunkHit;
    })
    .filter((h) => h.text.trim().length > 0);
}
