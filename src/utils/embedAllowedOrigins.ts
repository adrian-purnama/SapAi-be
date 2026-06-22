import { MAX_EMBED_ALLOWED_ORIGINS } from "../models/faqConstant.js";

const MAX_ORIGIN_CHARS = 256;

function allowedOriginProtocol(url: URL): boolean {
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    const h = url.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  }
  return false;
}

/**
 * Validates and normalizes parent origins for CSP `frame-ancestors` (no path/query   origin only).
 * @throws Error with user-facing message on invalid input
 */
export function assertAndNormalizeEmbedAllowedOrigins(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw) {
    const s = String(line).trim();
    if (!s) continue;
    if (s.length > MAX_ORIGIN_CHARS) {
      throw new Error(`Each origin must be at most ${MAX_ORIGIN_CHARS} characters.`);
    }
    let url: URL;
    try {
      url = new URL(s.includes("://") ? s : `https://${s}`);
    } catch {
      throw new Error(`Invalid origin: ${s.slice(0, 48)}`);
    }
    if (!allowedOriginProtocol(url)) {
      throw new Error(`Origin must use https, or http on localhost only: ${url.origin}`);
    }
    const origin = url.origin;
    if (seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
    if (out.length > MAX_EMBED_ALLOWED_ORIGINS) {
      throw new Error(`At most ${MAX_EMBED_ALLOWED_ORIGINS} embed allowed origins.`);
    }
  }
  return out;
}

/** CSP `frame-ancestors` tokens: keyword `'self'` plus any extra https origins. */
export function buildEmbedFrameAncestors(userOrigins: string[]): string[] {
  return ["'self'", ...userOrigins];
}
