/** Per-API-key / embed rate limits via shared store (Redis when REDIS_URL is set). */

import { resolveEffectivePlanForUser, type UserPlanContext } from "../services/planRegistry.js";
import { consumeRateLimitSlot } from "./rateLimitStore.js";

/** Fallback when the user has no resolvable plan. */
export function readDefaultApiKeyRateLimitPerMinute(): number {
  const raw = process.env.DEFAULT_API_KEY_RATE_LIMIT_PER_MINUTE?.trim();
  if (!raw) return 120;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 120;
  return Math.min(n, 1_000_000);
}

/**
 * Requests per minute from the user's effective plan.
 * `0` = unlimited. Falls back to env default when no plan is found.
 */
export function getRateLimitPerMinuteForUserPlan(ctx: UserPlanContext): number {
  const plan = resolveEffectivePlanForUser(ctx);
  if (plan) {
    const v = plan.rateLimitPerMinute;
    if (Number.isFinite(v) && v >= 0) return Math.min(v, 1_000_000);
  }
  return readDefaultApiKeyRateLimitPerMinute();
}

export async function tryConsumeApiKeyRateSlot(
  rateBucketId: string,
  limitPerMinute: number,
): Promise<boolean> {
  if (limitPerMinute <= 0) return true;
  const bucket = `apikey:${rateBucketId}`;
  const result = await consumeRateLimitSlot(bucket, limitPerMinute, 60);
  return result.allowed;
}
