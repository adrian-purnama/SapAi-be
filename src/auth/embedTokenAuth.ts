import crypto from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import mongoose from "mongoose";

import type { ApiKeyAuthFailure } from "./requireApiKey.js";
import { getClientIp, headerString, requireApiKey } from "./requireApiKey.js";
import { getRateLimitPerMinuteForUserPlan, tryConsumeApiKeyRateSlot } from "./apiKeyRateLimit.js";
import { ApiKeyModel } from "../models/ApiKey.js";
import { findFaqConstantByEmbedToken } from "../utils/embedTokenLookup.js";
import { UserModel } from "../models/User.js";
import type { ApiKeyAuthContext } from "../types/authContext.js";
import { resolvePlanForUser } from "../services/planRegistry.js";
import { planAllowsPublicEmbed } from "../utils/planAccess.js";

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function allowlistAllowsAll(allowlist: string[]): boolean {
  return allowlist.includes("0.0.0.0");
}

/**
 * Validates raw embed token (header `x-embed-token` or WS query `embedToken`).
 * Maps `FaqConstant.embedToken` + `embedEnabled` + `ApiKey` + `User` to the same `ApiKeyAuthContext` as API-key auth.
 */
export async function authenticatePlainEmbedToken(
  rawToken: string,
  request: FastifyRequest,
): Promise<{ ok: true; ctx: ApiKeyAuthContext } | { ok: false; failure: ApiKeyAuthFailure }> {
  const token = rawToken.trim();
  if (!token) {
    return {
      ok: false,
      failure: { status: 401, body: { message: "Embed token required.", code: "EMBED_TOKEN_REQUIRED" } },
    };
  }

  if (mongoose.connection.readyState !== 1) {
    return {
      ok: false,
      failure: {
        status: 503,
        body: { message: "MongoDB is not configured. Set MONGODB_URI in server/.env" },
      },
    };
  }

  const faqConst = await findFaqConstantByEmbedToken(token);
  if (!faqConst?.apiKeyId) {
    return {
      ok: false,
      failure: { status: 401, body: { message: "Invalid or disabled embed token.", code: "INVALID_EMBED_TOKEN" } },
    };
  }

  const apiKey = await ApiKeyModel.findOne({
    _id: faqConst.apiKeyId,
    revokedAt: null,
  }).lean();
  if (!apiKey) {
    return {
      ok: false,
      failure: { status: 401, body: { message: "Invalid embed token.", code: "INVALID_EMBED_TOKEN" } },
    };
  }

  if (apiKey.isDisabled) {
    return {
      ok: false,
      failure: {
        status: 403,
        body: {
          message: "This project's API key is disabled. Contact the account owner.",
          code: "API_KEY_DISABLED",
        },
      },
    };
  }

  const user = await UserModel.findById(apiKey.userId);
  if (!user) {
    return {
      ok: false,
      failure: { status: 401, body: { message: "User not found.", code: "USER_NOT_FOUND" } },
    };
  }
  if (user.isBlocked) {
    return {
      ok: false,
      failure: { status: 403, body: { message: "Account is blocked.", code: "USER_BLOCKED" } },
    };
  }

  const rateKey = `embed:${sha256Hex(token)}`;
  const perMinute = getRateLimitPerMinuteForUserPlan(user.plan);
  if (!(await tryConsumeApiKeyRateSlot(rateKey, perMinute))) {
    return {
      ok: false,
      failure: {
        status: 429,
        body: {
          message: "Too many requests for this embed. Try again later.",
          code: "RATE_LIMITED",
        },
      },
    };
  }

  const allowlist = (apiKey.ipAllowlist ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (allowlist.length > 0 && !allowlistAllowsAll(allowlist)) {
    const ip = getClientIp(request);
    if (!ip || !allowlist.includes(ip)) {
      return {
        ok: false,
        failure: { status: 403, body: { message: "IP not allowed.", code: "IP_NOT_ALLOWED" } },
      };
    }
  }

  const resolved = resolvePlanForUser(user.plan);
  if (!resolved || !planAllowsPublicEmbed(resolved)) {
    return {
      ok: false,
      failure: {
        status: 403,
        body: {
          message: "Public embed is not included in your subscription plan.",
          code: "EMBED_PLAN_REQUIRED",
        },
      },
    };
  }

  const ctx: ApiKeyAuthContext = {
    apiKeyId: apiKey._id.toString(),
    userId: user._id.toString(),
    plan: resolved.slug,
    label: apiKey.label,
    prefix: apiKey.prefix,
    email: user.email,
    isAdmin: Boolean(user.isAdmin),
  };
  return { ok: true, ctx };
}

export async function requireEmbedToken(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = headerString(request.headers["x-embed-token"]);
  const result = await authenticatePlainEmbedToken(raw ?? "", request);
  if (!result.ok) {
    await reply.code(result.failure.status).send(result.failure.body);
    return;
  }
  request.apiAuth = result.ctx;
}

export async function requireApiKeyOrEmbedToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const raw = headerString(request.headers["x-embed-token"]);
  if (raw?.trim()) {
    const result = await authenticatePlainEmbedToken(raw.trim(), request);
    if (!result.ok) {
      await reply.code(result.failure.status).send(result.failure.body);
      return;
    }
    request.apiAuth = result.ctx;
    return;
  }
  await requireApiKey(request, reply);
}

