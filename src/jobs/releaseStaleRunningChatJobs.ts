import mongoose from "mongoose";

import { ChatJobModel } from "../models/ChatJob.js";
import { readIntEnv } from "../utils/env.js";

const STALE_MSG =
  "Job was still running after the stale threshold; retries exhausted. See CHAT_JOB_STALE_RUNNING_MS.";

/**
 * Finds `chatjobs` stuck in `status: "running"` (crashed worker, hung Ollama, etc.),
 * increments `attempts`, then either resets to `pending` (retry) or marks `failed` with `STALE_RUN`
 * when `attempts` reaches `maxAttempts`.
 *
 * Stale criterion: `min(startedAt, createdAt)` (when `startedAt` is null, uses `createdAt`) is
 * older than `CHAT_JOB_STALE_RUNNING_MS` (default 45 minutes).
 */
export async function releaseStaleRunningChatJobs(now = new Date()): Promise<{
  matchedCount: number;
  modifiedCount: number;
}> {
  const staleMs = readIntEnv("CHAT_JOB_STALE_RUNNING_MS", 120 * 60 * 1000);
  const safeStale = Number.isFinite(staleMs) && staleMs >= 60_000 ? staleMs : 45 * 60 * 1000;
  const cutoff = new Date(now.getTime() - safeStale);

  const filter: mongoose.FilterQuery<unknown> = {
    status: "running",
    $expr: {
      $lt: [{ $ifNull: ["$startedAt", "$createdAt"] }, cutoff],
    },
  };

  const pipeline: mongoose.PipelineStage[] = [
    { $set: { attempts: { $add: [{ $ifNull: ["$attempts", 0] }, 1] } } },
    {
      $set: {
        status: {
          $cond: [
            { $gte: ["$attempts", { $ifNull: ["$maxAttempts", 3] }] },
            "failed",
            "pending",
          ],
        },
      },
    },
    {
      $set: {
        finishedAt: {
          $cond: [{ $eq: ["$status", "failed"] }, "$$NOW", "$finishedAt"],
        },
        startedAt: {
          $cond: [{ $eq: ["$status", "pending"] }, null, "$startedAt"],
        },
        error: {
          $cond: [
            { $eq: ["$status", "failed"] },
            { code: "STALE_RUN", message: STALE_MSG },
            null,
          ],
        },
      },
    },
  ];

  const res = await ChatJobModel.updateMany(filter, pipeline);
  const matched = res.matchedCount ?? 0;
  const modified = res.modifiedCount ?? 0;
  if (matched > 0) {
    console.warn(
      `[chatjobs] releaseStaleRunningChatJobs: matched=${matched} modified=${modified} (cutoff=${cutoff.toISOString()})`,
    );
  }
  return { matchedCount: matched, modifiedCount: modified };
}
