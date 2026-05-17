import { claimNextChatJob } from "./claimNextChatJob.js";
import { runChatJobById } from "./runChatJobById.js";

/** Between retries after a transient failure (not idle polling). */
const ERROR_BACKOFF_MS = 1000;

let stopped = true;
/** True while a tick chain is scheduled or running (prevents duplicate loops). */
let scheduling = false;

/**
 * Ensures a drain pass is running: claims and runs jobs until the queue is empty, then stops.
 * Safe to call on every new job (e.g. after `POST /api/v1/chat`): if a drain is already in
 * progress (`scheduling`), this is a no-op. No idle polling — only wakes from `startChatJobRunner`
 * or server startup (`index.ts`). Call `stopChatJobRunner` on shutdown.
 */
export function startChatJobRunner(): void {
  stopped = false;
  if (!scheduling) {
    scheduling = true;
    void tick();
  }
}

export function stopChatJobRunner(): void {
  stopped = true;
  scheduling = false;
}

async function tick(): Promise<void> {
  if (stopped) {
    scheduling = false;
    return;
  }

  try {
    const job = await claimNextChatJob();
    if (job?._id) {
      await runChatJobById(job._id.toString());
      setImmediate(() => void tick());
    } else {
      scheduling = false;
    }
  } catch {
    setTimeout(() => void tick(), ERROR_BACKOFF_MS);
  }
}
