import { FaqConstantModel } from "../models/faqConstant.js";
import { hashEmbedToken } from "./embedTokenHash.js";

/** Resolve embed settings by plaintext token (hashed or legacy plaintext in DB). */
export function findFaqConstantByEmbedTokenQuery(rawToken: string): Record<string, unknown> | null {
  const token = rawToken.trim();
  if (!token) return null;
  const hash = hashEmbedToken(token);
  return {
    embedEnabled: true,
    $or: [{ embedTokenHash: hash }, { embedToken: token }],
  };
}

export async function findFaqConstantByEmbedToken(rawToken: string) {
  const q = findFaqConstantByEmbedTokenQuery(rawToken);
  if (!q) return null;
  return FaqConstantModel.findOne(q).lean();
}
