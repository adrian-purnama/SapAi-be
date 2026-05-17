import mongoose from "mongoose";

import { FaqDocumentModel } from "../models/FaqDocument.js";
import { UserModel } from "../models/User.js";
import { resolvePlanForUser } from "../services/planRegistry.js";

const DEFAULT_MAX_PDF_MB = 15;
const DEFAULT_MAX_PDF_COUNT = 5;

export type FaqPlanLimits = {
  maxBytes: number;
  maxCount: number;
  maxPdfMb: number;
  maxPdfUpload: number;
};

export class FaqPlanLimitError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "FaqPlanLimitError";
    this.code = code;
  }
}

export async function getFaqLimitsForUser(userId: mongoose.Types.ObjectId): Promise<FaqPlanLimits> {
  const user = await UserModel.findById(userId).select("plan").lean();
  const plan = resolvePlanForUser(user?.plan);
  const maxPdfMb = plan?.maxPdfMb ?? DEFAULT_MAX_PDF_MB;
  const maxPdfUpload = plan?.maxPdfUpload ?? DEFAULT_MAX_PDF_COUNT;
  return {
    maxPdfMb,
    maxPdfUpload,
    maxBytes: maxPdfMb * 1024 * 1024,
    maxCount: maxPdfUpload,
  };
}

/** Enforces per-plan file size and project document count (POST only for count). */
export async function assertFaqUploadAllowed(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  fileSizeBytes: number,
  options?: { isNewDocument?: boolean },
): Promise<FaqPlanLimits> {
  const limits = await getFaqLimitsForUser(userId);

  if (fileSizeBytes > limits.maxBytes) {
    throw new FaqPlanLimitError(
      `File too large. Maximum size for your plan is ${limits.maxPdfMb} MB.`,
      "FILE_TOO_LARGE",
    );
  }

  if (options?.isNewDocument !== false) {
    const count = await FaqDocumentModel.countDocuments({ userId, apiKeyId });
    if (count >= limits.maxCount) {
      throw new FaqPlanLimitError(
        `PDF limit reached. Your plan allows up to ${limits.maxCount} file${limits.maxCount === 1 ? "" : "s"} per project.`,
        "PDF_LIMIT_REACHED",
      );
    }
  }

  return limits;
}
