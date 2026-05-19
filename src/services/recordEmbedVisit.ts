import type { FastifyRequest } from "fastify";
import mongoose from "mongoose";

import { ApiKeyModel } from "../models/ApiKey.js";
import { EmbedVisitModel } from "../models/EmbedVisit.js";
import { findFaqConstantByEmbedToken } from "../utils/embedTokenLookup.js";
import { readEmbedVisitorIp, readVisitorLocation } from "../utils/embedVisitIp.js";

export type EmbedVisitKind = "status" | "chat";

export type RecordEmbedVisitParams = {
  apiKeyId: string;
  userId: string;
  request: FastifyRequest;
  kind: EmbedVisitKind;
};

/** Resolve project + owner from an active embed token (for status route). */
export async function resolveEmbedVisitScope(
  rawToken: string,
): Promise<{ apiKeyId: string; userId: string } | null> {
  const faqConst = await findFaqConstantByEmbedToken(rawToken);
  if (!faqConst?.apiKeyId) return null;

  const apiKey = await ApiKeyModel.findOne({
    _id: faqConst.apiKeyId,
    revokedAt: null,
  })
    .select("userId")
    .lean();
  if (!apiKey?.userId) return null;

  return {
    apiKeyId: String(faqConst.apiKeyId),
    userId: String(apiKey.userId),
  };
}

/**
 * Upsert one row per (apiKeyId, ip). Never throws; safe to fire-and-forget.
 */
export async function recordEmbedVisit(params: RecordEmbedVisitParams): Promise<void> {
  const ipRaw = readEmbedVisitorIp(params.request);
  const ip = ipRaw?.trim();
  if (!ip) return;

  if (mongoose.connection.readyState !== 1) return;

  const apiKeyOid = new mongoose.Types.ObjectId(params.apiKeyId);
  const userOid = new mongoose.Types.ObjectId(params.userId);
  const now = new Date();
  const location = readVisitorLocation(params.request);

  const setOnInsert: Record<string, unknown> = {
    userId: userOid,
    firstSeenAt: now,
  };
  if (location) setOnInsert.location = location;
  if (params.kind !== "chat") {
    setOnInsert.messageCount = 0;
  }

  const update: Record<string, unknown> = {
    $setOnInsert: setOnInsert,
    $set: { lastSeenAt: now },
  };
  if (params.kind === "chat") {
    update.$inc = { messageCount: 1 };
  }

  await EmbedVisitModel.findOneAndUpdate({ apiKeyId: apiKeyOid, ip }, update, {
    upsert: true,
    new: false,
  });
}

export function recordEmbedVisitSafe(params: RecordEmbedVisitParams, log?: { warn: (o: object, m: string) => void }): void {
  void recordEmbedVisit(params).catch((err: unknown) => {
    log?.warn({ err }, "recordEmbedVisit failed");
  });
}
