import type { FastifyInstance } from "fastify";
import { buffer as readStreamToBuffer } from "node:stream/consumers";
import mongoose from "mongoose";

import { requireBearerUser } from "../auth/requireBearerUser.js";
import { FaqDocumentModel } from "../models/FaqDocument.js";
import { isFaqDocumentBusy } from "../constants/faqDocumentProcessing.js";
import {
  assertFaqDocumentNotBusy,
  FaqDocumentBusyError,
  isFaqDocumentPipelineRunning,
  scheduleFaqDocumentPipeline,
} from "../services/faqDocumentPipelineService.js";
import {
  assertAllowedFaqUpload,
  deleteFaqDocument,
  FaqUploadValidationError,
  getFaqDocumentForDownload,
  listFaqDocumentsForApiKey,
  readFaqDocumentBuffer,
  updateFaqDocument,
  uploadFaqDocument,
} from "../services/faqDocumentsService.js";
import { validateFaqDocumentExtractable } from "../services/faqChunkingService.js";
import { assertFaqUploadAllowed, FaqPlanLimitError } from "../utils/faqPlanLimits.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { requireActiveOwnedApiKey } from "../utils/requireOwnedApiKey.js";

function mapLimitError(reply: Parameters<typeof sendError>[0], err: FaqPlanLimitError) {
  const status = err.code === "PDF_LIMIT_REACHED" ? 403 : 400;
  return sendError(reply, err.message, status, err.code);
}

function mapBusyError(reply: Parameters<typeof sendError>[0]) {
  return sendError(
    reply,
    "This document is still being processed. Wait until it finishes or fails before replacing or deleting it.",
    409,
    "DOCUMENT_PROCESSING",
  );
}

async function faqDocumentPipelineResponse(
  documentId: string,
  userId: mongoose.Types.ObjectId,
  extra?: Record<string, unknown>,
) {
  const doc = await FaqDocumentModel.findOne({ _id: documentId, userId })
    .select("chunk processingStatus processingError isProcessed")
    .lean();
  const ch = doc?.chunk as { totalChunks?: number; processedChunks?: number } | undefined;
  const processingStatus = (doc?.processingStatus as string) ?? "chunking";
  return {
    documentId,
    chunkCount: typeof ch?.totalChunks === "number" ? ch.totalChunks : 0,
    processingStatus,
    isProcessed: processingStatus === "completed",
    ...(doc?.processingError?.message
      ? {
          processingError: {
            step: doc.processingError.step,
            message: String(doc.processingError.message),
          },
        }
      : {}),
    ...extra,
  };
}

export async function registerFaqDocumentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/api/v1/api-keys/:id/faq-documents",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      const user = request.bearerUser!;
      const id = String((request.params as { id?: string })?.id ?? "");

      const gate = await requireActiveOwnedApiKey(user._id, id);
      if (!gate.ok) {
        const code =
          gate.status === 403 ? "API_KEY_DISABLED" : gate.status === 400 ? "INVALID_ID" : "NOT_FOUND";
        return sendError(reply, gate.error, gate.status, code);
      }

      const limitRaw = (request.query as { limit?: string })?.limit;
      const limit = limitRaw ? Number.parseInt(String(limitRaw), 10) : 50;
      try {
        const documents = await listFaqDocumentsForApiKey(id, user._id, limit);
        return sendSuccess(reply, { documents });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to list documents.";
        return sendError(reply, message, 500, "FAQ_LIST_FAILED");
      }
    },
  );

  fastify.get(
    "/api/v1/faq-documents/:documentId",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      const user = request.bearerUser!;
      const documentId = String((request.params as { documentId?: string })?.documentId ?? "");
      if (!mongoose.isValidObjectId(documentId)) return sendError(reply, "Invalid document id.", 400, "INVALID_ID");

      try {
        const file = await getFaqDocumentForDownload(documentId, user._id);
        if (!file) return sendError(reply, "Document not found.", 404, "NOT_FOUND");

        const body = await readStreamToBuffer(file.stream);
        reply
          .code(200)
          .header("Content-Type", file.contentType)
          .header("Content-Length", String(body.length))
          .header("Cache-Control", "private, no-store, max-age=0")
          .header("Pragma", "no-cache")
          .header("Expires", "0")
          .header("Content-Disposition", `inline; filename="${encodeURIComponent(file.filename)}"`);
        return reply.send(body);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to serve document.";
        return sendError(reply, message, 500, "FAQ_SERVE_FAILED");
      }
    },
  );

  fastify.post(
    "/api/v1/faq-documents",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      const user = request.bearerUser!;
      const apiKeyId = String((request.query as { apiKeyId?: string })?.apiKeyId ?? "").trim();
      if (!apiKeyId) return sendError(reply, "Missing apiKeyId query parameter.", 400, "API_KEY_REQUIRED");

      const gate = await requireActiveOwnedApiKey(user._id, apiKeyId);
      if (!gate.ok) {
        const code =
          gate.status === 403 ? "API_KEY_DISABLED" : gate.status === 400 ? "INVALID_ID" : "NOT_FOUND";
        return sendError(reply, gate.error, gate.status, code);
      }

      const file = await (request as { file?: () => Promise<{ filename?: string; mimetype?: string; file: NodeJS.ReadableStream } | undefined> }).file?.();
      if (!file) return sendError(reply, 'Missing file field "file".', 400, "FILE_REQUIRED");

      const originalFilename = String(file.filename ?? "document");
      const mime = String(file.mimetype ?? "application/octet-stream");
      const buffer = await readStreamToBuffer(file.file);
      if (buffer.length <= 0) return sendError(reply, 'Missing or empty file field "file".', 400, "FILE_REQUIRED");

      try {
        try {
          assertAllowedFaqUpload(mime, originalFilename);
        } catch (e) {
          if (e instanceof FaqUploadValidationError) {
            return sendError(reply, e.message, 400, "INVALID_FILE_TYPE");
          }
          throw e;
        }

        const limits = await assertFaqUploadAllowed(user._id, gate.apiKeyOid, buffer.length, {
          isNewDocument: true,
        });

        const extractGate = await validateFaqDocumentExtractable(buffer, mime, originalFilename);
        if (!extractGate.ok) {
          return sendError(reply, extractGate.error, 400, "FAQ_EXTRACTION_FAILED");
        }

        const result = await uploadFaqDocument(buffer, {
          userId: user._id,
          apiKeyId: gate.apiKeyOid,
          originalFilename,
          contentType: mime,
          maxFileBytes: limits.maxBytes,
        });

        const { scheduled } = scheduleFaqDocumentPipeline({
          faqDocumentId: result.documentId,
          userId: user._id,
          apiKeyId: gate.apiKeyOid,
          buffer,
          contentType: mime,
          originalFilename,
          preExtractedText: extractGate.normalizedText,
          mode: "initial",
        });

        if (!scheduled) {
          return mapBusyError(reply);
        }

        return sendSuccess(
          reply,
          await faqDocumentPipelineResponse(result.documentId, user._id, {
            apiKeyId,
            originalFilename,
            contentType: mime,
            length: buffer.length,
            downloadUrl: `/api/v1/faq-documents/${encodeURIComponent(result.documentId)}`,
          }),
          201,
        );
      } catch (err) {
        if (err instanceof FaqPlanLimitError) return mapLimitError(reply, err);
        if (err instanceof FaqUploadValidationError) {
          return sendError(reply, err.message, 400, "INVALID_FILE_TYPE");
        }
        if (err instanceof FaqDocumentBusyError) return mapBusyError(reply);
        const message = err instanceof Error ? err.message : "Upload failed.";
        return sendError(reply, message, 500, "FAQ_UPLOAD_FAILED");
      }
    },
  );

  fastify.patch(
    "/api/v1/faq-documents/:documentId",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      const user = request.bearerUser!;
      const documentId = String((request.params as { documentId?: string })?.documentId ?? "");
      if (!mongoose.isValidObjectId(documentId)) return sendError(reply, "Invalid document id.", 400, "INVALID_ID");

      const file = await (request as { file?: () => Promise<{ filename?: string; mimetype?: string; file: NodeJS.ReadableStream } | undefined> }).file?.();
      if (!file) return sendError(reply, 'Missing file field "file".', 400, "FILE_REQUIRED");

      const originalFilename = String(file.filename ?? "document");
      const mime = String(file.mimetype ?? "application/octet-stream");
      const buffer = await readStreamToBuffer(file.file);
      if (buffer.length <= 0) return sendError(reply, 'Missing or empty file field "file".', 400, "FILE_REQUIRED");

      try {
        await assertFaqDocumentNotBusy(documentId, user._id);

        try {
          assertAllowedFaqUpload(mime, originalFilename);
        } catch (e) {
          if (e instanceof FaqUploadValidationError) {
            return sendError(reply, e.message, 400, "INVALID_FILE_TYPE");
          }
          throw e;
        }

        const meta = await FaqDocumentModel.findOne({
          _id: new mongoose.Types.ObjectId(documentId),
          userId: user._id,
        })
          .select("apiKeyId")
          .lean();
        if (!meta?.apiKeyId) return sendError(reply, "Document not found.", 404, "NOT_FOUND");

        const limits = await assertFaqUploadAllowed(user._id, meta.apiKeyId as mongoose.Types.ObjectId, buffer.length, {
          isNewDocument: false,
        });

        const extractGate = await validateFaqDocumentExtractable(buffer, mime, originalFilename);
        if (!extractGate.ok) {
          return sendError(reply, extractGate.error, 400, "FAQ_EXTRACTION_FAILED");
        }

        const result = await updateFaqDocument(documentId, user._id, buffer, {
          originalFilename,
          contentType: mime,
          maxFileBytes: limits.maxBytes,
        });

        const { scheduled } = scheduleFaqDocumentPipeline({
          faqDocumentId: result.documentId,
          userId: user._id,
          apiKeyId: meta.apiKeyId as mongoose.Types.ObjectId,
          buffer,
          contentType: mime,
          originalFilename,
          preExtractedText: extractGate.normalizedText,
          mode: "initial",
        });

        if (!scheduled) {
          return mapBusyError(reply);
        }

        return sendSuccess(
          reply,
          await faqDocumentPipelineResponse(result.documentId, user._id, {
            gridFsFileId: result.gridFsFileId,
            originalFilename,
            contentType: mime,
            length: buffer.length,
            downloadUrl: `/api/v1/faq-documents/${encodeURIComponent(result.documentId)}`,
          }),
        );
      } catch (err) {
        if (err instanceof FaqPlanLimitError) return mapLimitError(reply, err);
        if (err instanceof FaqUploadValidationError) {
          return sendError(reply, err.message, 400, "INVALID_FILE_TYPE");
        }
        if (err instanceof FaqDocumentBusyError) return mapBusyError(reply);
        if (err instanceof Error && err.message === "Document not found.") {
          return sendError(reply, "Document not found.", 404, "NOT_FOUND");
        }
        const message = err instanceof Error ? err.message : "Update failed.";
        return sendError(reply, message, 500, "FAQ_UPDATE_FAILED");
      }
    },
  );

  fastify.post(
    "/api/v1/faq-documents/:documentId/reprocess",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      const user = request.bearerUser!;
      const documentId = String((request.params as { documentId?: string })?.documentId ?? "");
      if (!mongoose.isValidObjectId(documentId)) return sendError(reply, "Invalid document id.", 400, "INVALID_ID");

      try {
        const stored = await readFaqDocumentBuffer(documentId, user._id);
        if (!stored) return sendError(reply, "Document not found.", 404, "NOT_FOUND");

        if (isFaqDocumentPipelineRunning(documentId)) {
          return mapBusyError(reply);
        }

        const { scheduled } = scheduleFaqDocumentPipeline({
          faqDocumentId: documentId,
          userId: user._id,
          apiKeyId: stored.apiKeyId,
          buffer: stored.buffer,
          contentType: stored.contentType,
          originalFilename: stored.originalFilename,
          mode: "reprocess",
        });

        if (!scheduled) {
          const meta = await FaqDocumentModel.findOne({ _id: documentId, userId: user._id })
            .select("processingStatus")
            .lean();
          if (meta && isFaqDocumentBusy(meta.processingStatus as string)) {
            return mapBusyError(reply);
          }
        }

        return sendSuccess(reply, await faqDocumentPipelineResponse(documentId, user._id));
      } catch (err) {
        if (err instanceof FaqDocumentBusyError) return mapBusyError(reply);
        const message = err instanceof Error ? err.message : "Reprocess failed.";
        return sendError(reply, message, 500, "FAQ_REPROCESS_FAILED");
      }
    },
  );

  fastify.delete(
    "/api/v1/faq-documents/:documentId",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      const user = request.bearerUser!;
      const documentId = String((request.params as { documentId?: string })?.documentId ?? "");
      if (!mongoose.isValidObjectId(documentId)) return sendError(reply, "Invalid document id.", 400, "INVALID_ID");

      try {
        const meta = await FaqDocumentModel.findOne({ _id: documentId, userId: user._id })
          .select("processingStatus")
          .lean();
        if (!meta) return sendError(reply, "Document not found.", 404, "NOT_FOUND");
        if (isFaqDocumentBusy(meta.processingStatus)) return mapBusyError(reply);

        const deleted = await deleteFaqDocument(documentId, user._id);
        if (!deleted) return sendError(reply, "Document not found.", 404, "NOT_FOUND");
        return sendSuccess(reply, { message: "Deleted." });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Delete failed.";
        return sendError(reply, message, 500, "FAQ_DELETE_FAILED");
      }
    },
  );
}
