import mongoose from "mongoose";

import type { FaqProcessingErrorStep, FaqProcessingStatus } from "../constants/faqDocumentProcessing.js";
import { isFaqDocumentBusy } from "../constants/faqDocumentProcessing.js";
import { FaqDocumentModel } from "../models/FaqDocument.js";
import { processFaqChunksWithCheckpoints, rebuildFaqChunks } from "./faqChunkingService.js";
import { deleteFaqDocumentPointsFromQdrant } from "./qdrantFaqChunksService.js";

export class FaqDocumentBusyError extends Error {
  constructor(message = "Document is still being processed.") {
    super(message);
    this.name = "FaqDocumentBusyError";
  }
}

const activePipelines = new Set<string>();

export function isFaqDocumentPipelineRunning(faqDocumentId: string): boolean {
  return activePipelines.has(faqDocumentId);
}

async function failPipelineUnhandled(
  faqDocumentId: string,
  userId: mongoose.Types.ObjectId,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : "Processing failed unexpectedly.";
  await FaqDocumentModel.updateOne(
    { _id: new mongoose.Types.ObjectId(faqDocumentId), userId },
    {
      $set: {
        processingStatus: "failed",
        processingUpdatedAt: new Date(),
        processingError: { step: "embedding", message },
        isProcessed: false,
      },
    },
  );
}

/**
 * Run chunking + embedding in the background so HTTP handlers return immediately.
 * Safe to call after upload/replace; duplicate schedules for the same document are ignored.
 */
export function scheduleFaqDocumentPipeline(params: RunFaqDocumentPipelineParams): { scheduled: boolean } {
  const key = params.faqDocumentId;
  if (activePipelines.has(key)) {
    console.warn("[faqDocumentPipeline] pipeline already active", { documentId: key });
    return { scheduled: false };
  }

  activePipelines.add(key);
  void runFaqDocumentPipeline(params)
    .catch((err) => {
      console.error("[faqDocumentPipeline] unhandled error", { documentId: key, err });
      return failPipelineUnhandled(params.faqDocumentId, params.userId, err);
    })
    .finally(() => {
      activePipelines.delete(key);
    });

  return { scheduled: true };
}

export type RunFaqDocumentPipelineParams = {
  faqDocumentId: string;
  userId: mongoose.Types.ObjectId;
  apiKeyId: mongoose.Types.ObjectId;
  buffer: Buffer;
  contentType: string;
  originalFilename: string;
  preExtractedText?: string;
  mode: "initial" | "reprocess";
};

export type RunFaqDocumentPipelineResult = {
  processingStatus: FaqProcessingStatus;
  chunkCount: number;
  chunkIds: string[];
  processingError?: { step: FaqProcessingErrorStep; message: string };
};

async function setProcessingStatus(
  faqDocumentId: mongoose.Types.ObjectId,
  status: FaqProcessingStatus,
  extra?: {
    processingError?: { step: FaqProcessingErrorStep; message: string } | null;
    isProcessed?: boolean;
    chunk?: { totalChunks: number; processedChunks: number };
  },
): Promise<void> {
  const $set: Record<string, unknown> = {
    processingStatus: status,
    processingUpdatedAt: new Date(),
  };
  if (extra?.processingError !== undefined) {
    $set.processingError = extra.processingError;
  }
  if (extra?.isProcessed !== undefined) {
    $set.isProcessed = extra.isProcessed;
  }
  if (extra?.chunk !== undefined) {
    $set.chunk = extra.chunk;
  }
  await FaqDocumentModel.updateOne({ _id: faqDocumentId }, { $set });
}

function logPipeline(documentId: string, message: string, detail?: Record<string, unknown>): void {
  console.info("[faqDocumentPipeline]", { documentId, message, ...detail });
}

export async function assertFaqDocumentNotBusy(
  documentId: string,
  userId: mongoose.Types.ObjectId,
): Promise<void> {
  const doc = await FaqDocumentModel.findOne({ _id: documentId, userId }).select("processingStatus").lean();
  if (!doc) throw new Error("Document not found.");
  if (isFaqDocumentBusy(doc.processingStatus as FaqProcessingStatus)) {
    throw new FaqDocumentBusyError();
  }
}

export async function runFaqDocumentPipeline(
  params: RunFaqDocumentPipelineParams,
): Promise<RunFaqDocumentPipelineResult> {
  const docOid = new mongoose.Types.ObjectId(params.faqDocumentId);
  const allowedFrom: FaqProcessingStatus[] =
    params.mode === "reprocess"
      ? ["completed", "failed", "chunking", "uploading_to_qdrant", "reprocessing", "uploaded"]
      : ["uploaded", "completed", "failed"];

  const nextStatus: FaqProcessingStatus = params.mode === "reprocess" ? "reprocessing" : "chunking";
  const claimed = await FaqDocumentModel.findOneAndUpdate(
    { _id: docOid, userId: params.userId, processingStatus: { $in: allowedFrom } },
    { $set: { processingStatus: nextStatus, processingUpdatedAt: new Date(), processingError: null } },
    { new: true },
  ).lean();

  if (!claimed) {
    const existing = await FaqDocumentModel.findOne({ _id: docOid, userId: params.userId })
      .select("processingStatus")
      .lean();
    if (!existing) throw new Error("Document not found.");
    if (isFaqDocumentBusy(existing.processingStatus as FaqProcessingStatus)) {
      throw new FaqDocumentBusyError();
    }
    throw new Error("Document cannot be processed in its current state.");
  }

  logPipeline(params.faqDocumentId, "pipeline started", { mode: params.mode });

  const qdrantWipe = await deleteFaqDocumentPointsFromQdrant(params.faqDocumentId);
  if (qdrantWipe.error) {
    logPipeline(params.faqDocumentId, "qdrant wipe warning", { error: qdrantWipe.error });
  }

  await setProcessingStatus(docOid, "chunking");

  const chunkInfo = await rebuildFaqChunks({
    faqDocumentId: params.faqDocumentId,
    userId: params.userId,
    apiKeyId: params.apiKeyId,
    buffer: params.buffer,
    contentType: params.contentType,
    originalFilename: params.originalFilename,
    preExtractedText: params.preExtractedText,
  });

  if (chunkInfo.extractionError) {
    const processingError = { step: "chunking" as const, message: chunkInfo.extractionError };
    await setProcessingStatus(docOid, "failed", {
      processingError,
      isProcessed: false,
      chunk: { totalChunks: 0, processedChunks: 0 },
    });
    logPipeline(params.faqDocumentId, "chunking failed", processingError);
    return {
      processingStatus: "failed",
      chunkCount: 0,
      chunkIds: [],
      processingError,
    };
  }

  if (chunkInfo.chunkIds.length === 0) {
    const processingError = {
      step: "chunking" as const,
      message: "No extractable text was found in this file.",
    };
    await setProcessingStatus(docOid, "failed", {
      processingError,
      isProcessed: false,
      chunk: { totalChunks: 0, processedChunks: 0 },
    });
    return {
      processingStatus: "failed",
      chunkCount: 0,
      chunkIds: [],
      processingError,
    };
  }

  logPipeline(params.faqDocumentId, "chunking complete", { chunkCount: chunkInfo.chunkCount });

  await setProcessingStatus(docOid, "uploading_to_qdrant", {
    chunk: { totalChunks: chunkInfo.chunkCount, processedChunks: 0 },
  });

  const indexResult = await processFaqChunksWithCheckpoints(chunkInfo.chunkIds, params.faqDocumentId);

  const allIndexed = indexResult.processed === chunkInfo.chunkCount && indexResult.failed === 0;

  if (!allIndexed) {
    const message =
      indexResult.errors.length > 0
        ? indexResult.errors.join("; ")
        : `Indexed ${indexResult.processed} of ${chunkInfo.chunkCount} chunks.`;
    const step: FaqProcessingErrorStep =
      indexResult.processed === 0 && indexResult.errors.some((e) => /Qdrant/i.test(e)) ? "qdrant" : "embedding";
    const processingError = { step, message };
    await setProcessingStatus(docOid, "failed", {
      processingError,
      isProcessed: false,
      chunk: { totalChunks: chunkInfo.chunkCount, processedChunks: indexResult.processed },
    });
    logPipeline(params.faqDocumentId, "pipeline failed (partial checkpoints may remain)", {
      step,
      processed: indexResult.processed,
      total: chunkInfo.chunkCount,
    });
    return {
      processingStatus: "failed",
      chunkCount: chunkInfo.chunkCount,
      chunkIds: chunkInfo.chunkIds,
      processingError,
    };
  }

  await setProcessingStatus(docOid, "completed", {
    processingError: null,
    isProcessed: true,
    chunk: { totalChunks: chunkInfo.chunkCount, processedChunks: indexResult.processed },
  });

  logPipeline(params.faqDocumentId, "pipeline completed", {
    chunkCount: chunkInfo.chunkCount,
    qdrantUpserted: indexResult.qdrantUpserted,
  });

  return {
    processingStatus: "completed",
    chunkCount: chunkInfo.chunkCount,
    chunkIds: chunkInfo.chunkIds,
  };
}
