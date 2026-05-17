import type { FastifyReply, FastifyRequest } from "fastify";

import { getClientIp } from "./requireApiKey.js";
import { consumeRateLimitSlot } from "./rateLimitStore.js";
import { sendError } from "../utils/apiResponse.js";

function clientIpBucket(request: FastifyRequest): string {
  return `ip:${getClientIp(request) ?? "unknown"}`;
}

function emailBucket(email: string, action: string): string {
  return `email:${action}:${email.toLowerCase()}`;
}

async function enforce(
  reply: FastifyReply,
  buckets: Array<{ key: string; limit: number; windowSec: number }>,
): Promise<boolean> {
  for (const { key, limit, windowSec } of buckets) {
    const result = await consumeRateLimitSlot(key, limit, windowSec);
    if (!result.allowed) {
      void sendError(reply, "Too many requests. Try again later.", 429, "RATE_LIMITED");
      reply.header("Retry-After", String(result.retryAfterSec));
      return false;
    }
  }
  return true;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Login: per IP and per email (failed attempts still hit IP bucket on all tries). */
export async function enforceLoginRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const ipLimit = readIntEnv("AUTH_LOGIN_IP_LIMIT", 10);
  const ipWindow = readIntEnv("AUTH_LOGIN_IP_WINDOW_SEC", 900);
  return enforce(reply, [{ key: clientIpBucket(request), limit: ipLimit, windowSec: ipWindow }]);
}

/** OTP send (registration / forgot-password). */
export async function enforceOtpSendRateLimit(
  email: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const ipLimit = readIntEnv("AUTH_OTP_SEND_IP_LIMIT", 10);
  const ipWindow = readIntEnv("AUTH_OTP_SEND_IP_WINDOW_SEC", 3600);
  const emailLimit = readIntEnv("AUTH_OTP_SEND_EMAIL_LIMIT", 3);
  const emailWindow = readIntEnv("AUTH_OTP_SEND_EMAIL_WINDOW_SEC", 3600);
  return enforce(reply, [
    { key: clientIpBucket(request), limit: ipLimit, windowSec: ipWindow },
    { key: emailBucket(email, "otp_send"), limit: emailLimit, windowSec: emailWindow },
  ]);
}

/** OTP verify (register / reset-password). */
export async function enforceOtpVerifyRateLimit(
  email: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const ipLimit = readIntEnv("AUTH_OTP_VERIFY_IP_LIMIT", 20);
  const ipWindow = readIntEnv("AUTH_OTP_VERIFY_IP_WINDOW_SEC", 900);
  return enforce(reply, [
    { key: clientIpBucket(request), limit: ipLimit, windowSec: ipWindow },
    { key: emailBucket(email, "otp_verify"), limit: ipLimit, windowSec: ipWindow },
  ]);
}
