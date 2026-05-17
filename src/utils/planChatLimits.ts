import { UserModel } from "../models/User.js";
import { getRateLimitPerMinuteForUserPlan } from "../auth/apiKeyRateLimit.js";
import { resolvePlanForUser, type PlanSnapshot } from "../services/planRegistry.js";

export class PlanLimitError extends Error {
  readonly code: string;

  constructor(message: string, code = "PROMPT_TOO_LONG") {
    super(message);
    this.name = "PlanLimitError";
    this.code = code;
  }
}

export type PlanUsageLimits = {
  plan: {
    slug: string;
    name: string;
    rateLimitPerMinute: number;
    maxCharacterPerMessage: number;
  } | null;
  /** Effective req/min cap (plan value or env fallback). */
  rateLimitPerMinute: number;
  maxCharacterPerMessage: number;
};

export async function getPlanUsageLimitsForUser(userId: string): Promise<PlanUsageLimits> {
  const user = await UserModel.findById(userId).select("plan").lean();
  const plan = resolvePlanForUser(user?.plan);
  const rateLimitPerMinute = getRateLimitPerMinuteForUserPlan(user?.plan);
  const maxCharacterPerMessage = plan?.maxCharacterPerMessage ?? 2000;

  return {
    plan: plan ? planToPublicLimits(plan) : null,
    rateLimitPerMinute,
    maxCharacterPerMessage,
  };
}

function planToPublicLimits(plan: PlanSnapshot): NonNullable<PlanUsageLimits["plan"]> {
  return {
    slug: plan.slug,
    name: plan.name,
    rateLimitPerMinute: plan.rateLimitPerMinute,
    maxCharacterPerMessage: plan.maxCharacterPerMessage,
  };
}

/** Enforces `Plan.maxCharacterPerMessage` on every message in `input` (chat + RAG). */
export async function assertChatInputWithinPlanLimits(
  userId: string,
  input: readonly { content: string }[],
): Promise<void> {
  const { maxCharacterPerMessage } = await getPlanUsageLimitsForUser(userId);

  for (let i = 0; i < input.length; i++) {
    const content = (input[i]?.content ?? "").trim();
    if (!content) {
      throw new PlanLimitError(`Message ${i + 1} cannot be empty.`, "EMPTY_MESSAGE");
    }
    if (content.length > maxCharacterPerMessage) {
      throw new PlanLimitError(
        `Message ${i + 1} exceeds your plan limit of ${maxCharacterPerMessage} characters (${content.length} given).`,
      );
    }
  }
}
