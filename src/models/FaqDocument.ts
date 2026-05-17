import mongoose, { type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

import {
  FAQ_PROCESSING_ERROR_STEPS,
  FAQ_PROCESSING_STATUSES,
} from "../constants/faqDocumentProcessing.js";

/** Metadata for blobs in GridFS bucket `faqDocuments`; scoped per user + API key (project). */
const faqDocumentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    apiKeyId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    gridFsFileId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true,
      index: true,
    },
    originalFilename: { type: String, required: true },
    contentType: { type: String, required: true },
    length: { type: Number, required: true },
    chunk: {
      totalChunks: { type: Number, default: 0 },
      processedChunks: { type: Number, default: 0 },
    },
    /** When true, downstream pipeline (e.g. embeddings) has finished for all chunks. */
    isProcessed: { type: Boolean, default: false },
    processingStatus: {
      type: String,
      enum: FAQ_PROCESSING_STATUSES,
      default: "uploaded",
      index: true,
    },
    processingError: {
      step: { type: String, enum: FAQ_PROCESSING_ERROR_STEPS },
      message: { type: String },
    },
    processingUpdatedAt: { type: Date },
  },
  { timestamps: true, collection: "faqdocuments" },
);

faqDocumentSchema.index({ userId: 1, apiKeyId: 1, createdAt: -1 });

export type FaqDocumentLean = InferSchemaType<typeof faqDocumentSchema>;
export type FaqDocumentDocument = HydratedDocument<FaqDocumentLean>;

export const FaqDocumentModel: Model<FaqDocumentLean> =
  mongoose.models.FaqDocument || mongoose.model<FaqDocumentLean>("FaqDocument", faqDocumentSchema);

