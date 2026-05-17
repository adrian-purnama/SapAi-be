import mongoose from "mongoose";
import type { WebSocket } from "ws";

import { ChatJobModel } from "../models/ChatJob.js";
import { toPublicChatJob } from "../utils/toPublicChatJob.js";

const WS_OPEN = 1;

const subscribers = new Map<string, Set<WebSocket>>();

function isTerminalChatJobStatus(status: string): boolean {
  return (
    status === "completed_partial" ||
    status === "completed_full" ||
    status === "failed" ||
    status === "cancelled"
  );
}

export function subscribeChatJobSocket(jobId: string, socket: WebSocket): void {
  let set = subscribers.get(jobId);
  if (!set) {
    set = new Set();
    subscribers.set(jobId, set);
  }
  set.add(socket);
}

export function unsubscribeChatJobSocket(jobId: string, socket: WebSocket): void {
  const set = subscribers.get(jobId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) subscribers.delete(jobId);
}

function broadcastJson(jobId: string, payload: unknown): void {
  const set = subscribers.get(jobId);
  if (!set || set.size === 0) return;
  const text = JSON.stringify(payload);
  for (const socket of set) {
    try {
      if (socket.readyState === WS_OPEN) {
        socket.send(text);
      }
    } catch {
      /* ignore */
    }
  }
}

function closeSocketsForJob(jobId: string): void {
  const set = subscribers.get(jobId);
  if (!set) return;
  for (const socket of set) {
    try {
      if (socket.readyState === WS_OPEN) {
        socket.close(1000, "job_terminal");
      }
    } catch {
      /* ignore */
    }
  }
  set.clear();
  subscribers.delete(jobId);
}

export async function notifyChatJobUpdated(jobId: string): Promise<void> {
  try {
    if (!mongoose.Types.ObjectId.isValid(jobId)) return;
    const job = await ChatJobModel.findById(new mongoose.Types.ObjectId(jobId))
      .select("-userId -plan -apiKeyId -input -attempts -maxAttempts -__v")
      .lean()
      .exec();
    if (!job) return;
    const payload = toPublicChatJob(job);
    broadcastJson(jobId, payload);
    if (isTerminalChatJobStatus(payload.status)) {
      closeSocketsForJob(jobId);
    }
  } catch (err) {
    console.error("[chatJobStatusHub] notifyChatJobUpdated:", err);
  }
}

/** Close every subscriber socket (Fastify `onClose`). */
export function shutdownChatJobStatusWsHub(): void {
  for (const jobId of [...subscribers.keys()]) {
    closeSocketsForJob(jobId);
  }
}
