import type { FastifyReply, FastifyRequest } from "fastify";

import { getClientIp } from "./requireApiKey.js";
import { consumeRateLimitSlot } from "./rateLimitStore.js";
import { sendError } from "../utils/apiResponse.js";

const LOGIN_IP_LIMIT = 10;
const LOGIN_IP_WINDOW_SEC = 900;
const OTP_SEND_IP_LIMIT = 10;
const OTP_SEND_IP_WINDOW_SEC = 3600;
const OTP_SEND_EMAIL_LIMIT = 3;
const OTP_SEND_EMAIL_WINDOW_SEC = 3600;
const OTP_VERIFY_IP_LIMIT = 20;
const OTP_VERIFY_IP_WINDOW_SEC = 900;

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

/** Login: per IP and per email (failed attempts still hit IP bucket on all tries). */
export async function enforceLoginRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  return enforce(reply, [{ key: clientIpBucket(request), limit: LOGIN_IP_LIMIT, windowSec: LOGIN_IP_WINDOW_SEC }]);
}

/** OTP send (registration / forgot-password). */
export async function enforceOtpSendRateLimit(
  email: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  return enforce(reply, [
    { key: clientIpBucket(request), limit: OTP_SEND_IP_LIMIT, windowSec: OTP_SEND_IP_WINDOW_SEC },
    { key: emailBucket(email, "otp_send"), limit: OTP_SEND_EMAIL_LIMIT, windowSec: OTP_SEND_EMAIL_WINDOW_SEC },
  ]);
}

/** OTP verify (register / reset-password). */
export async function enforceOtpVerifyRateLimit(
  email: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  return enforce(reply, [
    { key: clientIpBucket(request), limit: OTP_VERIFY_IP_LIMIT, windowSec: OTP_VERIFY_IP_WINDOW_SEC },
    { key: emailBucket(email, "otp_verify"), limit: OTP_VERIFY_IP_LIMIT, windowSec: OTP_VERIFY_IP_WINDOW_SEC },
  ]);
}
