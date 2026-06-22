import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import net from "node:net";
import mongoose from "mongoose";
import { z } from "zod";

import { requireBearerUser } from "../auth/requireBearerUser.js";
import { ApiKeyModel } from "../models/ApiKey.js";
import { deleteAllFaqDataForApiKeyInSession } from "../services/faqDocumentsService.js";
import { deleteFaqChunkPointsByApiKeyFromQdrant } from "../services/qdrantFaqChunksService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { sha256Hex } from "../utils/sha256.js";
import { syncUserApiKeysToPlan } from "../services/apiKeyPlanSyncService.js";
import {
  aggregateJobStatsByKeyIds,
  assertActivePlan,
  EMPTY_JOB_STATS,
  parseApiKeyRouteId,
  toPublicKeyDto,
} from "./apiKeyShared.js";

function generateApiKey(): string {
  const secret = crypto.randomBytes(32).toString("base64url");
  return `sapai_sk_${secret}`;
}

function parseIpAllowlist(raw: unknown): string[] {
  if (!raw) return [];
  const s = String(raw);
  const items = s
    .split(/[\n,]+/g)
    .map((v) => v.trim())
    .filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const ip of items) {
    if (seen.has(ip)) continue;
    seen.add(ip);
    out.push(ip);
  }
  if (out.includes("0.0.0.0")) return [];
  return out;
}

function validateExactIps(ips: string[]): string | null {
  for (const ip of ips) {
    if (net.isIP(ip) === 0) return `Invalid IP address: ${ip}`;
  }
  return null;
}

async function handleListApiKeys(request: FastifyRequest, reply: FastifyReply) {
  const user = request.bearerUser!;

  const keys = await ApiKeyModel.find({ userId: user._id }).sort({ createdAt: -1 }).lean();
  const keyIds = keys.map((k) => k._id as mongoose.Types.ObjectId);
  const statsByKeyId = await aggregateJobStatsByKeyIds(user._id, keyIds);

  return sendSuccess(reply, {
    keys: keys.map((k) => {
      const id = k._id.toString();
      return toPublicKeyDto(k, statsByKeyId.get(id) ?? { ...EMPTY_JOB_STATS });
    }),
  });
}

async function handleCreateApiKey(request: FastifyRequest, reply: FastifyReply) {
  try {
    const user = request.bearerUser!;
    const body = z
      .object({
        label: z.string().transform((v) => v.trim()),
        ipAllowlist: z.any().optional(),
      })
      .safeParse(request.body);
    if (!body.success) return sendError(reply, "Invalid request body.", 400, "INVALID_BODY");

    const label = body.data.label;
    const ipAllowlist = parseIpAllowlist(body.data.ipAllowlist);
    if (!label) return sendError(reply, "Label is required.", 400, "LABEL_REQUIRED");
    if (label.length > 80) return sendError(reply, "Label is too long.", 400, "LABEL_TOO_LONG");
    const ipError = validateExactIps(ipAllowlist);
    if (ipError) return sendError(reply, ipError, 400, "INVALID_IP");

    const plan = assertActivePlan(user, reply);
    if (!plan) return;

    const enabledKeyCount = await ApiKeyModel.countDocuments({
      userId: user._id,
      revokedAt: null,
      isDisabled: false,
    });

    if (enabledKeyCount >= plan.maxApiKeys) {
      return sendError(
        reply,
        `Plan limit reached: ${plan.name} allows at most ${plan.maxApiKeys} active API key(s). Revoke an existing key or upgrade your plan.`,
        403,
        "API_KEY_LIMIT_REACHED",
      );
    }

    const apiKey = generateApiKey();
    const hashedKey = sha256Hex(apiKey);
    const prefix = apiKey.slice(0, 12);

    const hasAnyKey = await ApiKeyModel.exists({ userId: user._id, revokedAt: null });

    const doc = await ApiKeyModel.create({
      userId: user._id,
      label,
      prefix,
      hashedKey,
      ipAllowlist,
      revokedAt: null,
      lastUsedAt: null,
      primaryKey: !hasAnyKey,
      isDisabled: false,
    });

    await syncUserApiKeysToPlan(user._id);

    const synced = await ApiKeyModel.findById(doc._id).lean();

    return sendSuccess(
      reply,
      {
        apiKey,
        key: toPublicKeyDto({
          ...doc.toObject(),
          primaryKey: Boolean(synced?.primaryKey),
          isDisabled: Boolean(synced?.isDisabled),
        }),
      },
      201,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create API key.";
    return sendError(reply, message, 500, "API_KEY_CREATE_FAILED");
  }
}

async function handlePatchApiKey(request: FastifyRequest, reply: FastifyReply) {
  const user = request.bearerUser!;
  const id = parseApiKeyRouteId(request, reply);
  if (!id) return;

  const parsed = z
    .object({
      ipAllowlist: z.any().optional(),
    })
    .safeParse(request.body ?? {});
  if (!parsed.success) {
    return sendError(reply, "Invalid request body.", 400, "INVALID_BODY");
  }

  if (parsed.data.ipAllowlist === undefined) {
    return sendError(reply, "Provide ipAllowlist.", 400, "NO_UPDATES");
  }

  const doc = await ApiKeyModel.findOne({
    _id: new mongoose.Types.ObjectId(id),
    userId: user._id,
    revokedAt: null,
  });
  if (!doc) return sendError(reply, "API key not found.", 404, "NOT_FOUND");
  if (doc.isDisabled) {
    return sendError(
      reply,
      "This API key is disabled for your current plan.",
      403,
      "API_KEY_DISABLED",
    );
  }

  try {
    const ips = parseIpAllowlist(parsed.data.ipAllowlist);
    const ipErr = validateExactIps(ips);
    if (ipErr) return sendError(reply, ipErr, 400, "INVALID_IP");
    doc.ipAllowlist = ips;
    await doc.save();

    return sendSuccess(reply, {
      key: {
        id: doc._id.toString(),
        label: doc.label,
        prefix: doc.prefix,
        ipAllowlist: doc.ipAllowlist ?? [],
        ipAllowlistCount: (doc.ipAllowlist ?? []).length,
        lastUsedAt: doc.lastUsedAt ? new Date(doc.lastUsedAt).toISOString() : null,
        revokedAt: null,
        createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update API key.";
    return sendError(reply, message, 500, "API_KEY_UPDATE_FAILED");
  }
}

async function handleDeleteApiKey(request: FastifyRequest, reply: FastifyReply) {
  const user = request.bearerUser!;
  const id = parseApiKeyRouteId(request, reply);
  if (!id) return;

  const apiKeyOid = new mongoose.Types.ObjectId(id);
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const existing = await ApiKeyModel.findOne({
        _id: apiKeyOid,
        userId: user._id,
        revokedAt: null,
      }).session(session);

      if (!existing) {
        throw new Error("API_KEY_NOT_FOUND");
      }

      await deleteAllFaqDataForApiKeyInSession(apiKeyOid, user._id, session);

      existing.revokedAt = new Date();
      await existing.save({ session });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "API_KEY_NOT_FOUND") {
      return sendError(reply, "API key not found.", 404, "NOT_FOUND");
    }
    const message = e instanceof Error ? e.message : "Failed to revoke API key.";
    return sendError(reply, message, 500, "API_KEY_REVOKE_FAILED");
  } finally {
    await session.endSession();
  }

  const qr = await deleteFaqChunkPointsByApiKeyFromQdrant(id);
  if (!qr.skipped && !qr.ok) {
    return sendError(
      reply,
      `API key revoked but vector index cleanup failed: ${qr.error ?? "unknown error"}`,
      500,
      "QDRANT_CLEANUP_FAILED",
    );
  }

  return sendSuccess(reply, { message: "Revoked." });
}

async function handleRotateApiKey(request: FastifyRequest, reply: FastifyReply) {
  const user = request.bearerUser!;
  const id = parseApiKeyRouteId(request, reply);
  if (!id) return;

  const existing = await ApiKeyModel.findOne({
    _id: new mongoose.Types.ObjectId(id),
    userId: user._id,
    revokedAt: null,
  });
  if (!existing) return sendError(reply, "API key not found.", 404, "NOT_FOUND");

  const apiKey = generateApiKey();
  const hashedKey = sha256Hex(apiKey);
  const prefix = apiKey.slice(0, 12);

  existing.revokedAt = new Date();
  await existing.save();

  const replacement = await ApiKeyModel.create({
    userId: user._id,
    label: existing.label,
    prefix,
    hashedKey,
    ipAllowlist: existing.ipAllowlist ?? [],
    revokedAt: null,
    lastUsedAt: null,
    primaryKey: Boolean(existing.primaryKey),
    isDisabled: false,
  });

  await syncUserApiKeysToPlan(user._id);

  const synced = await ApiKeyModel.findById(replacement._id).lean();

  return sendSuccess(reply, {
    apiKey,
    key: toPublicKeyDto({
      ...replacement.toObject(),
      primaryKey: Boolean(synced?.primaryKey),
      isDisabled: Boolean(synced?.isDisabled),
    }),
  });
}

export async function registerApiKeyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/v1/api-keys", { preHandler: requireBearerUser }, handleListApiKeys);
  fastify.post("/api/v1/api-keys", { preHandler: requireBearerUser }, handleCreateApiKey);
  fastify.patch("/api/v1/api-keys/:id", { preHandler: requireBearerUser }, handlePatchApiKey);
  fastify.delete("/api/v1/api-keys/:id", { preHandler: requireBearerUser }, handleDeleteApiKey);
  fastify.post("/api/v1/api-keys/:id/rotate", { preHandler: requireBearerUser }, handleRotateApiKey);
}
