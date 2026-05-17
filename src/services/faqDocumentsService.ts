import type { ClientSession } from "mongodb";
import mongoose from "mongoose";
import { buffer as readStreamToBuffer } from "node:stream/consumers";

import { FAQ_ALLOWED_EXTENSION } from "../constants/faqDocument.js";
import type { FaqProcessingError, FaqProcessingStatus } from "../constants/faqDocumentProcessing.js";
import { FaqChunkModel } from "../models/FaqChunk.js";
import { FaqDocumentModel } from "../models/FaqDocument.js";
import { deleteFaqDocumentPointsFromQdrant } from "./qdrantFaqChunksService.js";

export const MAX_FAQ_DOCUMENT_BYTES = 15 * 1024 * 1024;
export const FAQ_DOCUMENTS_BUCKET = "faqDocuments";

export { FAQ_ALLOWED_EXTENSION };

const ALLOWED_MIME_FOR_MD = new Set([
  "text/markdown",
  "text/plain",
  "application/octet-stream",
]);

export class FaqUploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaqUploadValidationError";
  }
}

function extFromFilename(filename: string): string {
  const i = filename.lastIndexOf(".");
  if (i < 0) return "";
  return filename.slice(i).toLowerCase();
}

export function assertAllowedFaqUpload(contentType: string, filename: string): void {
  const ext = extFromFilename(filename || "");
  if (ext !== FAQ_ALLOWED_EXTENSION) {
    throw new FaqUploadValidationError(
      "Only Markdown (.md) files are supported. Export your handbook or docs as .md and upload again.",
    );
  }
  const mime = (contentType || "").split(";")[0]?.trim().toLowerCase() || "";
  if (mime && !ALLOWED_MIME_FOR_MD.has(mime)) {
    throw new FaqUploadValidationError(
      "Content type not allowed for knowledge files. Use a .md file (text/markdown or text/plain).",
    );
  }
}

function getDb() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB connection is not ready.");
  return db;
}

function toObjectId(id: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new Error("Invalid document id.");
  }
  return new mongoose.Types.ObjectId(id);
}

export function getFaqDocumentsBucket() {
  return new mongoose.mongo.GridFSBucket(getDb(), { bucketName: FAQ_DOCUMENTS_BUCKET });
}

function uploadBufferToGridFs(
  bucket: mongoose.mongo.GridFSBucket,
  buffer: Buffer,
  originalFilename: string,
  contentType: string,
  session?: ClientSession,
): Promise<mongoose.Types.ObjectId> {
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(originalFilename, {
      ...(session ? { session } : {}),
      metadata: { contentType },
    });
    uploadStream.once("finish", () => resolve(uploadStream.id as mongoose.Types.ObjectId));
    uploadStream.once("error", reject);
    uploadStream.end(buffer);
  });
}

export type UploadFaqDocumentParams = {
  userId: mongoose.Types.ObjectId;
  apiKeyId: mongoose.Types.ObjectId;
  originalFilename: string;
  contentType: string;
  /** Max file size in bytes (from plan); defaults to legacy 15 MB cap. */
  maxFileBytes?: number;
};

export type UploadFaqDocumentResult = {
  documentId: string;
  gridFsFileId: string;
};

export async function uploadFaqDocument(
  buffer: Buffer,
  params: UploadFaqDocumentParams,
  session?: ClientSession,
): Promise<UploadFaqDocumentResult> {
  assertAllowedFaqUpload(params.contentType, params.originalFilename);
  const maxBytes = params.maxFileBytes ?? MAX_FAQ_DOCUMENT_BYTES;
  if (buffer.length > maxBytes) {
    throw new FaqUploadValidationError(
      `File too large. Maximum size is ${Math.round(maxBytes / (1024 * 1024))} MB.`,
    );
  }

  const bucket = getFaqDocumentsBucket();
  const gridFsFileId = await uploadBufferToGridFs(
    bucket,
    buffer,
    params.originalFilename,
    params.contentType,
    session,
  );

  const doc = new FaqDocumentModel({
    userId: params.userId,
    apiKeyId: params.apiKeyId,
    gridFsFileId,
    originalFilename: params.originalFilename,
    contentType: params.contentType,
    length: buffer.length,
    chunk: { totalChunks: 0, processedChunks: 0 },
    isProcessed: false,
    processingStatus: "uploaded",
    processingUpdatedAt: new Date(),
  });
  await doc.save(session ? { session } : {});

  return { documentId: doc._id.toString(), gridFsFileId: gridFsFileId.toString() };
}

/**
 * Removes every FAQ GridFS file, `FaqChunk`, and `FaqDocument` row for the given project key.
 * Must run inside an active Mongo session / transaction. Qdrant cleanup is separate.
 */
export async function deleteAllFaqDataForApiKeyInSession(
  apiKeyId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
  session: ClientSession,
): Promise<{ deletedDocumentCount: number }> {
  const docs = await FaqDocumentModel.find({ apiKeyId, userId })
    .session(session)
    .select("_id gridFsFileId")
    .lean();

  const bucket = getFaqDocumentsBucket();
  for (const meta of docs) {
    const _id = meta._id as mongoose.Types.ObjectId;
    const gfsId = meta.gridFsFileId as mongoose.Types.ObjectId;
    // @ts-expect-error GridFSBucket.delete supports session at runtime
    await bucket.delete(gfsId, { session });
    await FaqChunkModel.deleteMany({ faqDocumentId: _id }).session(session);
    await FaqDocumentModel.deleteOne({ _id }).session(session);
  }

  return { deletedDocumentCount: docs.length };
}

export async function deleteFaqDocument(
  documentId: string,
  userId: mongoose.Types.ObjectId,
  session?: ClientSession,
): Promise<boolean> {
  const _id = toObjectId(documentId);

  const query = FaqDocumentModel.findOne({ _id, userId });
  const meta = session ? await query.session(session).lean() : await query.lean();
  if (!meta) return false;

  const gfsId = meta.gridFsFileId as mongoose.Types.ObjectId;
  const bucket = getFaqDocumentsBucket();

  if (session) {
    // @ts-expect-error GridFSBucket.delete supports session at runtime
    await bucket.delete(gfsId, { session });
    await FaqChunkModel.deleteMany({ faqDocumentId: _id }).session(session);
    await FaqDocumentModel.deleteOne({ _id }).session(session);
  } else {
    await bucket.delete(gfsId);
    await FaqChunkModel.deleteMany({ faqDocumentId: _id });
    await FaqDocumentModel.deleteOne({ _id });
  }

  const qdrant = await deleteFaqDocumentPointsFromQdrant(documentId);
  if (qdrant.error) {
    console.warn("[faqDocumentsService] Qdrant cleanup after delete failed (Mongo already removed)", qdrant.error);
  }

  return true;
}

export async function updateFaqDocument(
  documentId: string,
  userId: mongoose.Types.ObjectId,
  buffer: Buffer,
  options: { originalFilename: string; contentType: string; maxFileBytes?: number },
): Promise<UploadFaqDocumentResult> {
  assertAllowedFaqUpload(options.contentType, options.originalFilename);
  const maxBytes = options.maxFileBytes ?? MAX_FAQ_DOCUMENT_BYTES;
  if (buffer.length > maxBytes) {
    throw new FaqUploadValidationError(
      `File too large. Maximum size is ${Math.round(maxBytes / (1024 * 1024))} MB.`,
    );
  }

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const existing = await FaqDocumentModel.findOne({ _id: toObjectId(documentId), userId }).session(session);
      if (!existing) throw new Error("Document not found.");

      const oldGfsId = existing.gridFsFileId as mongoose.Types.ObjectId;
      const bucket = getFaqDocumentsBucket();
      // @ts-expect-error session on delete
      await bucket.delete(oldGfsId, { session });

      const newGridFsId = await uploadBufferToGridFs(
        bucket,
        buffer,
        options.originalFilename,
        options.contentType,
        session,
      );

      existing.gridFsFileId = newGridFsId;
      existing.originalFilename = options.originalFilename;
      existing.contentType = options.contentType;
      existing.length = buffer.length;
      existing.isProcessed = false;
      existing.processingStatus = "uploaded";
      existing.processingError = undefined;
      existing.processingUpdatedAt = new Date();
      await existing.save({ session });

      return { documentId: existing._id.toString(), gridFsFileId: newGridFsId.toString() };
    });
  } finally {
    await session.endSession();
  }
}

export type FaqDocumentDownload = {
  stream: NodeJS.ReadableStream;
  contentType: string;
  filename: string;
  length: number;
};

export async function getFaqDocumentForDownload(
  documentId: string,
  userId: mongoose.Types.ObjectId,
): Promise<FaqDocumentDownload | null> {
  const _id = toObjectId(documentId);
  const meta = await FaqDocumentModel.findOne({ _id, userId }).lean();
  if (!meta) return null;

  const bucket = getFaqDocumentsBucket();
  const gfsId = meta.gridFsFileId as mongoose.Types.ObjectId;
  const stream = bucket.openDownloadStream(gfsId);
  return {
    stream,
    contentType: meta.contentType,
    filename: meta.originalFilename,
    length: meta.length,
  };
}

export type FaqDocumentListItem = {
  id: string;
  apiKeyId: string;
  originalFilename: string;
  contentType: string;
  length: number;
  chunk: { totalChunks: number; processedChunks: number };
  isProcessed: boolean;
  processingStatus: FaqProcessingStatus;
  processingError: FaqProcessingError | null;
  processingUpdatedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export async function readFaqDocumentBuffer(
  documentId: string,
  userId: mongoose.Types.ObjectId,
): Promise<{ buffer: Buffer; contentType: string; originalFilename: string; apiKeyId: mongoose.Types.ObjectId } | null> {
  const download = await getFaqDocumentForDownload(documentId, userId);
  if (!download) return null;

  const meta = await FaqDocumentModel.findOne({ _id: toObjectId(documentId), userId })
    .select("apiKeyId contentType originalFilename")
    .lean();
  if (!meta?.apiKeyId) return null;

  const buffer = await readStreamToBuffer(download.stream);
  return {
    buffer,
    contentType: meta.contentType,
    originalFilename: meta.originalFilename,
    apiKeyId: meta.apiKeyId as mongoose.Types.ObjectId,
  };
}

export async function listFaqDocumentsForApiKey(
  apiKeyId: string,
  userId: mongoose.Types.ObjectId,
  limit = 50,
): Promise<FaqDocumentListItem[]> {
  const keyOid = toObjectId(apiKeyId);
  const rows = await FaqDocumentModel.find({ userId, apiKeyId: keyOid })
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 100))
    .lean();

  return rows.map((r) => {
    const ch = r.chunk as { totalChunks?: number; processedChunks?: number } | undefined;
    return {
      id: r._id.toString(),
      apiKeyId: r.apiKeyId.toString(),
      originalFilename: r.originalFilename,
      contentType: r.contentType,
      length: r.length,
      chunk: {
        totalChunks: typeof ch?.totalChunks === "number" ? ch.totalChunks : 0,
        processedChunks: typeof ch?.processedChunks === "number" ? ch.processedChunks : 0,
      },
      isProcessed: Boolean(r.isProcessed),
      processingStatus: (r.processingStatus as FaqProcessingStatus) ?? "uploaded",
      processingError:
        r.processingError?.step && r.processingError?.message
          ? { step: r.processingError.step as FaqProcessingError["step"], message: String(r.processingError.message) }
          : null,
      processingUpdatedAt: r.processingUpdatedAt ? new Date(r.processingUpdatedAt).toISOString() : null,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    };
  });
}

