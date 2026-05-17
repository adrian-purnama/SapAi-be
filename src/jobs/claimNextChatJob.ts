import type { ChatJobDocument } from "../models/ChatJob.js";
import { ChatJobModel } from "../models/ChatJob.js";

/**
 * Atomically claims the oldest pending chat job (FIFO).
 * Returns `null` if no pending jobs.
 */
export async function claimNextChatJob(): Promise<ChatJobDocument | null> {
  const doc = await ChatJobModel.findOneAndUpdate(
    { status: "pending" },
    { $set: { status: "running", startedAt: new Date() } },
    { sort: { createdAt: 1 }, new: true },
  );
  return doc;
}
