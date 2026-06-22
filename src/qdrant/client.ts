import { QdrantClient } from "@qdrant/js-client-rest";

let cachedClient: QdrantClient | null | undefined;

export function getFaqChunksCollectionName(): string {
  return process.env.QDRANT_FAQ_COLLECTION?.trim() || "faq_chunks";
}

function readQdrantEnv(): { url: string; apiKey: string } {
  const url = (process.env.QDRANT_URL ?? "").trim();
  const apiKey = (process.env.QDRANT_API_KEY ?? "").trim();
  return { url, apiKey };
}

export function getQdrantClient(): QdrantClient | null {
  const { url, apiKey } = readQdrantEnv();
  if (!url) return null;
  if (cachedClient === undefined) {
    cachedClient = new QdrantClient({ url, apiKey: apiKey || undefined });
  }
  return cachedClient;
}

export function getQdrantContext(): { client: QdrantClient; collection: string } | null {
  const client = getQdrantClient();
  if (!client) return null;
  return { client, collection: getFaqChunksCollectionName() };
}

export function safeQdrantOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(invalid QDRANT_URL)";
  }
}
