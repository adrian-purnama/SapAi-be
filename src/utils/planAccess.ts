import type { PlanSnapshot } from "../services/planRegistry.js";
import { resolvePlanForUser } from "../services/planRegistry.js";

export type PlanPublicSnapshot = {
  slug: string;
  name: string;
  analyticsRetentionDays: number;
  ragAnalyticsEnabled: boolean;
  isAutoEmbed: boolean;
  isPriority: boolean;
  rateLimitPerMinute: number;
  maxCharacterPerMessage: number;
  maxChatInFlight: number;
  maxPdfUpload: number;
  maxPdfMb: number;
};

export function planToPublicSnapshot(plan: PlanSnapshot): PlanPublicSnapshot {
  return {
    slug: plan.slug,
    name: plan.name,
    analyticsRetentionDays: plan.analyticsRetentionDays,
    ragAnalyticsEnabled: plan.ragAnalyticsEnabled,
    isAutoEmbed: plan.isAutoEmbed,
    isPriority: plan.isPriority,
    rateLimitPerMinute: plan.rateLimitPerMinute,
    maxCharacterPerMessage: plan.maxCharacterPerMessage,
    maxChatInFlight: plan.maxChatInFlight,
    maxPdfUpload: plan.maxPdfUpload,
    maxPdfMb: plan.maxPdfMb,
  };
}

export function resolvePlanPublicForUser(planRef: unknown): PlanPublicSnapshot | null {
  const plan = resolvePlanForUser(planRef);
  return plan ? planToPublicSnapshot(plan) : null;
}

export function planAllowsRagAnalytics(plan: PlanSnapshot): boolean {
  return Boolean(plan.ragAnalyticsEnabled);
}

export function planAllowsPublicEmbed(plan: PlanSnapshot): boolean {
  return Boolean(plan.isAutoEmbed);
}

export type EmbedAppBadgePolicy = "none" | "required" | "customizable";

export function resolveEmbedAppBadgePolicy(plan: PlanSnapshot | null): EmbedAppBadgePolicy {
  if (!plan || !planAllowsPublicEmbed(plan)) return "none";
  return plan.embedBadgeCustomizable ? "customizable" : "required";
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

function subtractUtcDays(from: Date, days: number): Date {
  const t = from.getTime() - days * 86_400_000;
  return startOfUtcDay(new Date(t));
}

/**
 * Dashboard job history + RAG analytics share this UTC window.
 * - `analyticsRetentionDays === 0`: today (UTC) only; request dates ignored.
 * - else: optional from/to clamped to [now − retentionDays, end of today UTC].
 */
export function clampUsageAndAnalyticsDateRange(
  plan: PlanSnapshot,
  requestedFrom: Date | undefined,
  requestedTo: Date | undefined,
  now = new Date(),
): { from: Date; to: Date } {
  const nowEnd = endOfUtcDay(now);
  const nowStart = startOfUtcDay(now);

  if (plan.analyticsRetentionDays <= 0) {
    return { from: nowStart, to: nowEnd };
  }

  const earliest = subtractUtcDays(now, plan.analyticsRetentionDays);

  let from = requestedFrom != null ? startOfUtcDay(requestedFrom) : earliest;
  let to = requestedTo != null ? endOfUtcDay(requestedTo) : nowEnd;

  if (from < earliest) from = earliest;
  if (to > nowEnd) to = nowEnd;
  if (from > to) {
    return { from: earliest, to: nowEnd };
  }
  return { from, to };
}
