import mongoose from "mongoose";

import { startChatJobRunner } from "../jobs/chatJobRunner.js";
import { runChatJobById } from "../jobs/runChatJobById.js";
import { ChatJobModel } from "../models/ChatJob.js";
import { MAX_CHAT_MAX_TOKENS } from "../constants/chatLimits.js";
import type { NormalizedChatJobCreateBody } from "../schemas/chatJobBody.js";
import type { ApiKeyAuthContext } from "../types/authContext.js";
import { assertChatJobAllowedForCreate } from "../utils/planChatLimits.js";
import type { ChatSessionPublic } from "./chatSessionService.js";

export type CreatedChatJobPayload = {
  jobId: string;
  status: string;
  taskType: string;
  model: string;
  createdAt: Date | undefined;
  session?: ChatSessionPublic;
};

export type CreateChatJobOptions = {
  error?: (obj: Record<string, unknown>, msg: string) => void;
  sessionId?: string;
  session?: ChatSessionPublic;
};

/** Persist job and start runner (validation in assertChatJobAllowedForCreate). */
export async function createAndQueueChatJob(
  auth: ApiKeyAuthContext,
  body: NormalizedChatJobCreateBody,
  logOrOpts?: { error: (obj: Record<string, unknown>, msg: string) => void } | CreateChatJobOptions,
): Promise<CreatedChatJobPayload> {
  const opts: CreateChatJobOptions =
    logOrOpts && "error" in logOrOpts && typeof logOrOpts.error === "function"
      ? logOrOpts
      : (logOrOpts as CreateChatJobOptions | undefined) ?? {};
  const log = opts.error;

  const planSnap = await assertChatJobAllowedForCreate(auth, body);

  const sessionOid =
    opts.sessionId && mongoose.Types.ObjectId.isValid(opts.sessionId)
      ? new mongoose.Types.ObjectId(opts.sessionId)
      : undefined;

  const doc = await ChatJobModel.create({
    userId: new mongoose.Types.ObjectId(auth.userId),
    plan: planSnap.slug,
    apiKeyId: new mongoose.Types.ObjectId(auth.apiKeyId),
    taskType: body.taskType,
    model: body.model,
    input: body.input,
    maxTokens: Math.min(body.maxTokens ?? 500, MAX_CHAT_MAX_TOKENS),
    status: "pending",
    ...(sessionOid ? { sessionId: sessionOid } : {}),
  });

  const runJobImmediately = Boolean(planSnap.isPriority);
  if (runJobImmediately) {
    const id = doc._id.toString();
    void runChatJobById(id).catch((err: unknown) => {
      log?.({ err, jobId: id }, "runChatJobById rejected (priority inline)");
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
    ...(opts.session ? { session: opts.session } : {}),
  };
}
