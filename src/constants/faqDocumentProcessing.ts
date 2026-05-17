export const FAQ_PROCESSING_STATUSES = [
  "uploaded",
  "chunking",
  "uploading_to_qdrant",
  "completed",
  "failed",
  "reprocessing",
] as const;

export type FaqProcessingStatus = (typeof FAQ_PROCESSING_STATUSES)[number];

export const FAQ_PROCESSING_ERROR_STEPS = ["chunking", "embedding", "qdrant"] as const;

export type FaqProcessingErrorStep = (typeof FAQ_PROCESSING_ERROR_STEPS)[number];

export type FaqProcessingError = {
  step: FaqProcessingErrorStep;
  message: string;
};

const BUSY_STATUSES = new Set<FaqProcessingStatus>([
  "uploaded",
  "chunking",
  "uploading_to_qdrant",
  "reprocessing",
]);

export function isFaqDocumentBusy(status: FaqProcessingStatus | string | undefined | null): boolean {
  return BUSY_STATUSES.has(status as FaqProcessingStatus);
}
