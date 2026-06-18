import mongoose from "mongoose";

import { UserModel } from "../models/User.js";
import { ChatJobModel, CHAT_JOB_IN_FLIGHT_STATUSES } from "../models/ChatJob.js";
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
    maxChatInFlight: number;
  } | null;
  /** Effective req/min cap (plan value or env fallback). */
  rateLimitPerMinute: number;
  maxCharacterPerMessage: number;
  maxChatInFlight: number;
};

export async function getPlanUsageLimitsForUser(userId: string): Promise<PlanUsageLimits> {
  const user = await UserModel.findById(userId).select("plan").lean();
  const plan = resolvePlanForUser(user?.plan);
  const rateLimitPerMinute = getRateLimitPerMinuteForUserPlan(user?.plan);
  const maxCharacterPerMessage = plan?.maxCharacterPerMessage ?? 2000;
  const maxChatInFlight = plan?.maxChatInFlight ?? 5;

  return {
    plan: plan ? planToPublicLimits(plan) : null,
    rateLimitPerMinute,
    maxCharacterPerMessage,
    maxChatInFlight,
  };
}

function planToPublicLimits(plan: PlanSnapshot): NonNullable<PlanUsageLimits["plan"]> {
  return {
    slug: plan.slug,
    name: plan.name,
    rateLimitPerMinute: plan.rateLimitPerMinute,
    maxCharacterPerMessage: plan.maxCharacterPerMessage,
    maxChatInFlight: plan.maxChatInFlight,
  };
}

/** Enforces `Plan.maxCharacterPerMessage` on translate `text` (before prompt expansion). */
export async function assertTranslateTextWithinPlanLimits(userId: string, text: string): Promise<void> {
  const { maxCharacterPerMessage } = await getPlanUsageLimitsForUser(userId);
  const content = text.trim();
  if (!content) {
    throw new PlanLimitError("text cannot be empty.", "EMPTY_MESSAGE");
  }
  if (content.length > maxCharacterPerMessage) {
    throw new PlanLimitError(
      `text exceeds your plan limit of ${maxCharacterPerMessage} characters (${content.length} given).`,
    );
  }
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

/** Enforces `Plan.maxChatInFlight` on the user's in-flight jobs (`pending` + `queued` + `running`). */
export async function assertChatInFlightWithinPlanLimits(userId: string): Promise<void> {
  const { maxChatInFlight } = await getPlanUsageLimitsForUser(userId);
  if (maxChatInFlight === 0) return;

  const count = await ChatJobModel.countDocuments({
    userId: new mongoose.Types.ObjectId(userId),
    status: { $in: CHAT_JOB_IN_FLIGHT_STATUSES },
  });

  if (count >= maxChatInFlight) {
    throw new PlanLimitError(
      `Your plan allows at most ${maxChatInFlight} in-flight chat job(s). Wait for existing jobs to finish or upgrade your plan.`,
      "TOO_MANY_IN_FLIGHT_JOBS",
    );
  }
}
