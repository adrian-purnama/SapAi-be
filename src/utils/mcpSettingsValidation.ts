import {
  MAX_MCP_BODY_BYTES,
  MAX_MCP_HEADER_KEYS,
  MAX_MCP_HEADER_VALUE_LEN,
  MAX_MCP_URL_LEN,
} from "../models/ApiKeyMcpSettings.js";

const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function isAllowedMcpUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > MAX_MCP_URL_LEN) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && LOCAL_HTTP_HOSTS.has(u.hostname)) return true;
  return false;
}

export function normalizeMcpHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("headers must be a JSON object of strings.");
  }
  const out: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_MCP_HEADER_KEYS) {
    throw new Error(`At most ${MAX_MCP_HEADER_KEYS} headers allowed.`);
  }
  for (const [key, value] of entries) {
    const k = key.trim();
    if (!k) continue;
    if (typeof value !== "string") {
      throw new Error(`Header "${k}" must be a string.`);
    }
    const v = value.trim();
    if (v.length > MAX_MCP_HEADER_VALUE_LEN) {
      throw new Error(`Header "${k}" exceeds ${MAX_MCP_HEADER_VALUE_LEN} characters.`);
    }
    out[k] = v;
  }
  return out;
}

export function normalizeMcpBody(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("body must be a JSON object.");
  }
  const json = JSON.stringify(raw);
  if (json.length > MAX_MCP_BODY_BYTES) {
    throw new Error(`body exceeds ${MAX_MCP_BODY_BYTES} bytes.`);
  }
  return raw as Record<string, unknown>;
}




