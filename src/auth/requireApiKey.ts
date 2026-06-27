import type { FastifyReply, FastifyRequest } from "fastify";
import mongoose from "mongoose";

import type { ApiKeyAuthContext } from "../types/authContext.js";
import { getRateLimitPerMinuteForUserPlan, tryConsumeApiKeyRateSlot } from "./apiKeyRateLimit.js";
import { ApiKeyModel } from "../models/ApiKey.js";
import { UserModel } from "../models/User.js";
import { resolveEffectivePlanForUser } from "../services/planRegistry.js";
import { applyExpiredPlanDowngradeIfNeeded } from "../services/userPlanExpiryService.js";
import { sha256Hex } from "../utils/sha256.js";

export function headerString(h: string | string[] | undefined): string | undefined {
  if (h === undefined) return undefined;
  return Array.isArray(h) ? h[0] : h;
}

export function getClientIp(request: FastifyRequest): string | null {
  const trustProxy = process.env.TRUST_PROXY === "true";
  if (trustProxy) {
    const xff = headerString(request.headers["x-forwarded-for"]);
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
    const xrip = headerString(request.headers["x-real-ip"]);
    if (xrip?.trim()) return xrip.trim();
    if (request.ip?.trim()) return request.ip.trim();
  }
  if (request.socket?.remoteAddress) return request.socket.remoteAddress;
  return request.ip?.trim() || null;
}

function allowlistAllowsAll(allowlist: string[]): boolean {
  return allowlist.includes("0.0.0.0");
}

export type ApiKeyAuthFailure = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * Resolves a raw API key string (same semantics as `x-api-key` header) for HTTP or WebSocket.
 * Applies rate limit, IP allowlist, user block checks, and bumps `lastUsedAt` on success.
 */
export async function authenticatePlainApiKey(
  rawKey: string,
  request: FastifyRequest,
): Promise<{ ok: true; ctx: ApiKeyAuthContext } | { ok: false; failure: ApiKeyAuthFailure }> {
  // 1. Require a non-empty API key (x-api-key header or equivalent).
  const key = rawKey.trim();
  if (!key) {
    return {
      ok: false,
      failure: { status: 401, body: { message: "API key required.", code: "API_KEY_REQUIRED" } },
    };
  }

  // 2. Require MongoDB   auth lookups depend on ApiKey / User collections.
  if (mongoose.connection.readyState !== 1) {
    return {
      ok: false,
      failure: {
        status: 503,
        body: { message: "MongoDB is not configured. Set MONGODB_URI in server/.env" },
      },
    };
  }

  // 3. Resolve API key: SHA-256 hash match, must exist and not be revoked.
  const hashedKey = sha256Hex(key);
  const apiKey = await ApiKeyModel.findOne({ hashedKey, revokedAt: null });
  if (!apiKey) {
    return {
      ok: false,
      failure: { status: 401, body: { message: "Invalid API key.", code: "INVALID_API_KEY" } },
    };
  }

  // 4. Reject disabled keys (e.g. extra keys on plans that only allow one active key).
  if (apiKey.isDisabled) {
    return {
      ok: false,
      failure: {
        status: 403,
        body: {
          message: "API key is disabled. Upgrade your plan or use your primary key.",
          code: "API_KEY_DISABLED",
        },
      },
    };
  }

  // 5. Load owning user   key is invalid if the account row is missing.
  const user = await UserModel.findById(apiKey.userId).select("plan planExpiresAt email isAdmin isBlocked");
  if (!user) {
    return {
      ok: false,
      failure: { status: 401, body: { message: "User not found.", code: "USER_NOT_FOUND" } },
    };
  }

  // 6. Reject blocked accounts.
  if (user.isBlocked) {
    return {
      ok: false,
      failure: { status: 403, body: { message: "Account is blocked.", code: "USER_BLOCKED" } },
    };
  }

  await applyExpiredPlanDowngradeIfNeeded(user._id);
  const freshUser =
    (await UserModel.findById(apiKey.userId).select("plan planExpiresAt email isAdmin isBlocked")) ?? user;

  // 7. Rate limit per API key, cap derived from the user's plan.
  const planCtx = { plan: freshUser.plan, planExpiresAt: freshUser.planExpiresAt };
  const perMinute = getRateLimitPerMinuteForUserPlan(planCtx);
  if (!(await tryConsumeApiKeyRateSlot(apiKey._id.toString(), perMinute))) {
    return {
      ok: false,
      failure: {
        status: 429,
        body: {
          message: "Too many requests for this API key. Try again later.",
          code: "RATE_LIMITED",
        },
      },
    };
  }

  // 8. IP allowlist   skipped when empty or when allowlist contains 0.0.0.0 (allow all).
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

  // 9. Success   record last use (fire-and-forget).
  void ApiKeyModel.updateOne({ _id: apiKey._id }, { $set: { lastUsedAt: new Date() } }).catch(
    () => undefined,
  );

  // 10. Build request auth context for downstream handlers.
  const ctx: ApiKeyAuthContext = {
    apiKeyId: apiKey._id.toString(),
    userId: user._id.toString(),
    plan: resolveEffectivePlanForUser(planCtx)?.slug ?? "unknown",
    label: apiKey.label,
    prefix: apiKey.prefix,
    email: freshUser.email,
    isAdmin: Boolean(freshUser.isAdmin),
  };
  return { ok: true, ctx };
}

/** Validates `x-api-key`; sets `request.apiAuth` on success. */
export async function requireApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = headerString(request.headers["x-api-key"]);
  const result = await authenticatePlainApiKey(raw ?? "", request);
  if (!result.ok) {
    await reply.code(result.failure.status).send(result.failure.body);
    return;
  }
  request.apiAuth = result.ctx;
}
