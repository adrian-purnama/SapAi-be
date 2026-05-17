/**
 * Fixed-window counters for rate limiting. Uses Redis when REDIS_URL is set; otherwise in-memory (single instance).
 */

import { Redis } from "ioredis";

const SEP = "\x1f";
const memory = new Map<string, number>();

export type RateLimitConsumeResult = { allowed: true } | { allowed: false; retryAfterSec: number };

function windowKey(bucket: string, windowSec: number): string {
  const slot = Math.floor(Date.now() / (windowSec * 1000));
  return `${bucket}${SEP}${slot}`;
}

function pruneMemory(currentSlot: number): void {
  if (memory.size <= 10_000) return;
  const minSlot = currentSlot - 2;
  for (const k of memory.keys()) {
    const parts = k.split(SEP);
    const s = Number(parts[parts.length - 1]);
    if (!Number.isFinite(s) || s < minSlot) memory.delete(k);
  }
}

let redisClient: Redis | null = null;

function getRedisClient(): Redis | null {
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  if (!redisClient) {
    redisClient = new Redis(url, { maxRetriesPerRequest: 2 });
  }
  return redisClient;
}

async function redisIncrShared(key: string, windowSec: number): Promise<number> {
  const client = await getRedisClient();
  if (!client) throw new Error("no redis");
  const count = await client.incr(key);
  if (count === 1) await client.expire(key, windowSec);
  return count;
}

export async function consumeRateLimitSlot(
  bucket: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitConsumeResult> {
  if (limit <= 0) return { allowed: true };
  const key = windowKey(bucket, windowSec);

  let count: number;
  if (process.env.REDIS_URL?.trim()) {
    try {
      count = await redisIncrShared(key, windowSec);
    } catch {
      count = (memory.get(key) ?? 0) + 1;
      memory.set(key, count);
    }
  } else {
    count = (memory.get(key) ?? 0) + 1;
    memory.set(key, count);
    const slot = Math.floor(Date.now() / (windowSec * 1000));
    pruneMemory(slot);
  }

  if (count > limit) {
    const retryAfterSec = windowSec - (Math.floor(Date.now() / 1000) % windowSec);
    return { allowed: false, retryAfterSec: Math.max(1, retryAfterSec) };
  }
  return { allowed: true };
}

export async function shutdownRateLimitRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => undefined);
    redisClient = null;
  }
}
