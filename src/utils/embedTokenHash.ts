import { sha256Hex } from "./sha256.js";

export function hashEmbedToken(raw: string): string {
  return sha256Hex(raw.trim());
}
