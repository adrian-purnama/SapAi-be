import mongoose from "mongoose";

import { startChatJobRunner } from "../jobs/chatJobRunner.js";
import { runChatJobById } from "../jobs/runChatJobById.js";
import { ChatJobModel } from "../models/ChatJob.js";
import { MAX_CHAT_MAX_TOKENS } from "../constants/chatLimits.js";
import type { NormalizedChatJobCreateBody } from "../schemas/chatJobBody.js";
import type { ApiKeyAuthContext } from "../types/authContext.js";
import { assertChatJobAllowedForCreate } from "../utils/planChatLimits.js";

export type CreatedChatJobPayload = {
  jobId: string;
  status: string;
  taskType: string;
  model: string;
  createdAt: Date | undefined;
};

/** Persist job and start runner (validation in assertChatJobAllowedForCreate). */
export async function createAndQueueChatJob(
  auth: ApiKeyAuthContext,
  body: NormalizedChatJobCreateBody,
  log?: { error: (obj: Record<string, unknown>, msg: string) => void },
): Promise<CreatedChatJobPayload> {
  const planSnap = await assertChatJobAllowedForCreate(auth, body);

  const doc = await ChatJobModel.create({
    userId: new mongoose.Types.ObjectId(auth.userId),
    plan: planSnap.slug,
    apiKeyId: new mongoose.Types.ObjectId(auth.apiKeyId),
    taskType: body.taskType,
    model: body.model,
    input: body.input,
    maxTokens: Math.min(body.maxTokens ?? 500, MAX_CHAT_MAX_TOKENS),
    status: "pending",
  });

  const runJobImmediately = Boolean(planSnap.isPriority);
  if (runJobImmediately) {
    const id = doc._id.toString();
    void runChatJobById(id).catch((err: unknown) => {
      log?.error({ err, jobId: id }, "runChatJobById rejected (priority inline)");
    });
  } else {
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
