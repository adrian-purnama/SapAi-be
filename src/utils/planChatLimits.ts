import mongoose from "mongoose";

import type { ApiKeyAuthContext } from "../types/authContext.js";
import type { NormalizedChatJobCreateBody } from "../schemas/chatJobBody.js";
import { UserModel } from "../models/User.js";
import { ChatJobModel, CHAT_JOB_IN_FLIGHT_STATUSES } from "../models/ChatJob.js";
import { DEFAULT_MAX_OCR_MB } from "../constants/chatLimits.js";
import { getRateLimitPerMinuteForUserPlan } from "../auth/apiKeyRateLimit.js";
import {
  getEffectivePlanForUserId,
  getPlanBySlugFromRegistry,
  resolveEffectivePlanForUser,
  type PlanSnapshot,
} from "../services/planRegistry.js";
import { assertPlanAllowsTaskAndModel, planToPublicSnapshot } from "../utils/planAccess.js";
import { LimitError, limitErrorHttpStatus } from "./limitError.js";

export { LimitError, limitErrorHttpStatus };
export { LimitError as PlanLimitError, limitErrorHttpStatus as planLimitHttpStatus };

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
  const user = await UserModel.findById(userId).select("plan planExpiresAt").lean();
  const planCtx = { plan: user?.plan, planExpiresAt: user?.planExpiresAt };
  const plan = resolveEffectivePlanForUser(planCtx);
  const rateLimitPerMinute = getRateLimitPerMinuteForUserPlan(planCtx);
  const maxCharacterPerMessage = plan?.maxCharacterPerMessage ?? 2000;
  const maxChatInFlight = plan?.maxChatInFlight ?? 5;

  return {
    plan: plan ? planUsagePlanFromSnapshot(plan) : null,
    rateLimitPerMinute,
    maxCharacterPerMessage,
    maxChatInFlight,
  };
}

function planUsagePlanFromSnapshot(plan: PlanSnapshot): NonNullable<PlanUsageLimits["plan"]> {
  const pub = planToPublicSnapshot(plan);
  return {
    slug: pub.slug,
    name: pub.name,
    rateLimitPerMinute: pub.rateLimitPerMinute,
    maxCharacterPerMessage: pub.maxCharacterPerMessage,
    maxChatInFlight: pub.maxChatInFlight,
  };
}

/** Enforces `Plan.maxCharacterPerMessage` on translate `text` (before prompt expansion). */
export async function assertTranslateTextWithinPlanLimits(userId: string, text: string): Promise<void> {
  const { maxCharacterPerMessage } = await getPlanUsageLimitsForUser(userId);
  const content = text.trim();
  if (!content) {
    throw new LimitError("text cannot be empty.", "EMPTY_MESSAGE");
  }
  if (content.length > maxCharacterPerMessage) {
    throw new LimitError(
      `text exceeds your plan limit of ${maxCharacterPerMessage} characters (${content.length} given).`,
      "MESSAGE_TOO_LONG",
    );
  }
}

/** Enforces `Plan.maxOcrMb` on OCR `imageBase64` (decoded size estimate). */
export async function assertOcrImageWithinPlanLimits(userId: string, imageBase64: string): Promise<void> {
  const plan = await getEffectivePlanForUserId(userId);
  const maxOcrMb = plan?.maxOcrMb ?? DEFAULT_MAX_OCR_MB;
  const trimmed = imageBase64.trim();
  if (!trimmed) {
    throw new LimitError("imageBase64 cannot be empty.", "EMPTY_IMAGE");
  }
  const maxBytes = maxOcrMb * 1024 * 1024;
  const approxDecodedBytes = Math.floor((trimmed.length * 3) / 4);
  if (approxDecodedBytes > maxBytes) {
    const givenMb = Math.max(1, Math.ceil(approxDecodedBytes / (1024 * 1024)));
    throw new LimitError(
      `imageBase64 exceeds your plan limit of ${maxOcrMb} MB (approx ${givenMb} MB given).`,
      "IMAGE_TOO_LARGE",
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
      throw new LimitError(`Message ${i + 1} cannot be empty.`, "EMPTY_MESSAGE");
    }
    if (content.length > maxCharacterPerMessage) {
      throw new LimitError(
        `Message ${i + 1} exceeds your plan limit of ${maxCharacterPerMessage} characters (${content.length} given).`,
        "MESSAGE_TOO_LONG",
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
    throw new LimitError(
      `Your plan allows at most ${maxChatInFlight} in-flight chat job(s). Wait for existing jobs to finish or upgrade your plan.`,
      "TOO_MANY_IN_FLIGHT_JOBS",
    );
  }
}

/** Plan-backed gate before job insert: task/model access, message length, in-flight cap. */
export async function assertChatJobAllowedForCreate(
  auth: ApiKeyAuthContext,
  body: NormalizedChatJobCreateBody,
): Promise<PlanSnapshot> {
  const plan = getPlanBySlugFromRegistry(auth.plan);
  if (!plan) {
    throw new LimitError("No subscription plan found.", "PLAN_NOT_FOUND");
  }
  assertPlanAllowsTaskAndModel(plan, body.taskType, body.model);
  await assertChatInputWithinPlanLimits(auth.userId, body.input);
  await assertChatInFlightWithinPlanLimits(auth.userId);
  return plan;
}
