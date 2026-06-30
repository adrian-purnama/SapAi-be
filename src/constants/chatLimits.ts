/** Idle chat session lifetime (sliding window refreshed on assert). */
export const RAG_SESSION_TTL_MS = 60 * 60 * 1000;

/** Global caps for chat job payloads (below plan per-message limits). */
export const MAX_CHAT_INPUT_MESSAGES = 50;
export const MAX_CHAT_OUTPUT_JSON_TEMPLATE_CHARS = 12_000;
export const MAX_CHAT_MAX_TOKENS = 8_192;

/** Plan schema max for OCR image size (decoded bytes). */
export const MAX_PLAN_OCR_MB = 512;
export const DEFAULT_MAX_OCR_MB = 10;

/** Fastify JSON body limit for POST /api/v1/chat (base64 expands ~4/3). */
export function ocrJsonBodyLimitBytes(maxOcrMb: number): number {
  return Math.ceil(maxOcrMb * 1024 * 1024 * (4 / 3)) + 65_536;
}
