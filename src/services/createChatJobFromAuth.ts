import mongoose from "mongoose";

import { startChatJobRunner } from "../jobs/chatJobRunner.js";
import { runChatJobById } from "../jobs/runChatJobById.js";
import { ChatJobModel } from "../models/ChatJob.js";
import { MAX_CHAT_MAX_TOKENS } from "../constants/chatLimits.js";
import type { NormalizedChatJobCreateBody } from "../schemas/chatJobBody.js";
import type { ApiKeyAuthContext } from "../types/authContext.js";
import { getPlanBySlugFromRegistry } from "../services/planRegistry.js";
import {
  assertChatInputWithinPlanLimits,
  assertChatInFlightWithinPlanLimits,
  PlanLimitError,
} from "../utils/planChatLimits.js";
import { assertPlanAllowsTaskAndModel } from "../utils/planAccess.js";

export type CreatedChatJobPayload = {
  jobId: string;
  status: string;
  taskType: string;
  model: string;
  createdAt: Date | undefined;
};

/**
 * Persists a chat job and starts the runner / inline execution (same rules as `POST /api/v1/chat`).
 */
export async function createAndQueueChatJob(
  auth: ApiKeyAuthContext,
  body: NormalizedChatJobCreateBody,
  log?: { error: (obj: Record<string, unknown>, msg: string) => void },
): Promise<CreatedChatJobPayload> {
  
  // security check
  await assertChatInputWithinPlanLimits(auth.userId, body.input);
  await assertChatInFlightWithinPlanLimits(auth.userId);

  const planSnap = getPlanBySlugFromRegistry(auth.plan);
  if (!planSnap) {
    throw new PlanLimitError("No subscription plan found.", "PLAN_NOT_FOUND");
  }
  assertPlanAllowsTaskAndModel(planSnap, body.taskType, body.model);

  const planSlug = planSnap.slug;

  //create job
  const doc = await ChatJobModel.create({
    userId: new mongoose.Types.ObjectId(auth.userId),
    plan: planSlug,
    apiKeyId: new mongoose.Types.ObjectId(auth.apiKeyId),
    taskType: body.taskType,
    model: body.model,
    input: body.input,
    maxTokens: Math.min(body.maxTokens ?? 500, MAX_CHAT_MAX_TOKENS),
    status: "pending",
  });

  //run job immediately if priority plan
  const runJobImmediately = Boolean(planSnap.isPriority);
  if (runJobImmediately) {
    const id = doc._id.toString();
    void runChatJobById(id).catch((err: unknown) => {
      log?.error({ err, jobId: id }, "runChatJobById rejected (priority inline)");
    });
  } else {
    ///main start runner
    startChatJobRunner();
  }

  return {
    jobId: doc._id.toString(),
    status: runJobImmediately ? "running" : doc.status,
    taskType: doc.taskType,
    model: doc.model,
    createdAt: doc.createdAt,
  };
}
