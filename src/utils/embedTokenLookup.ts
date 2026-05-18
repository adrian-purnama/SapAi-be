import { FaqConstantModel } from "../models/faqConstant.js";

/** Resolve embed settings by plaintext token. */
export function findFaqConstantByEmbedTokenQuery(rawToken: string): Record<string, unknown> | null {
  const token = rawToken.trim();
  if (!token) return null;
  return { embedEnabled: true, embedToken: token };
}

export async function findFaqConstantByEmbedToken(rawToken: string) {
  const q = findFaqConstantByEmbedTokenQuery(rawToken);
  if (!q) return null;
  return FaqConstantModel.findOne(q).lean();
}
