import type { PlanSnapshot, UserPlanContext } from "../services/planRegistry.js";
import { resolveEffectivePlanForUser } from "../services/planRegistry.js";
import { isChatTaskType } from "../constants/taskCatalog.js";
import { PlanLimitError } from "./planChatLimits.js";

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
  maxOcrMb: number;
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
    maxOcrMb: plan.maxOcrMb,
  };
}

export function resolvePlanPublicForUser(ctx: UserPlanContext): PlanPublicSnapshot | null {
  const plan = resolveEffectivePlanForUser(ctx);
  return plan ? planToPublicSnapshot(plan) : null;
}

export type EmbedAppBadgePolicy = "none" | "required" | "customizable";

export function resolveEmbedAppBadgePolicy(plan: PlanSnapshot | null): EmbedAppBadgePolicy {
  if (!plan?.isAutoEmbed) return "none";
  return plan.embedBadgeCustomizable ? "customizable" : "required";
}

export function normalizePlanTaskAccess(plan: PlanSnapshot): Record<string, string[]> {
  return { ...plan.taskAccess };
}

export function getPlanTaskAccessView(plan: PlanSnapshot): {
  taskTypes: string[];
  modelsByTask: Record<string, string[]>;
} {
  const modelsByTask = normalizePlanTaskAccess(plan);
  return {
    taskTypes: Object.keys(modelsByTask),
    modelsByTask,
  };
}

export function assertPlanAllowsTaskAndModel(
  plan: PlanSnapshot,
  taskType: string,
  modelLabel: string,
): void {
  const access = normalizePlanTaskAccess(plan);
  const allowedModels = access[taskType];
  if (!allowedModels) {
    throw new PlanLimitError(
      `Task type "${taskType}" is not included in your subscription plan.`,
      "TASK_NOT_ALLOWED",
    );
  }
  if (!isChatTaskType(taskType)) {
    throw new PlanLimitError(`Unknown task type: ${taskType}`, "TASK_NOT_ALLOWED");
  }
  if (!allowedModels.includes(modelLabel)) {
    throw new PlanLimitError(
      `Model "${modelLabel}" is not available for task "${taskType}" on your plan.`,
      "MODEL_NOT_ALLOWED",
    );
  }
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

export function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/** Accepts YYYY-MM-DD or ISO; stores end of UTC day. null = never expires. */
export function parsePlanExpiresAtInput(raw: string | null | undefined): Date | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00.000Z`) : new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error("INVALID_PLAN_EXPIRY");
  return endOfUtcDay(d);
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
