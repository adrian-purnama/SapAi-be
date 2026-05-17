import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { buffer as readStreamToBuffer } from "node:stream/consumers";
import { getPublicFileForDownload } from "../services/publicFilesService.js";
import { sendError } from "../utils/apiResponse.js";
import { clientErrorMessage } from "../utils/sanitizeError.js";

export async function registerFilesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/v1/files/:id", async (request, reply) => {
    try {
      const id = String((request.params as { id?: string })?.id ?? "").trim();
      if (!mongoose.isValidObjectId(id)) {
        return sendError(reply, "File not found.", 404, "NOT_FOUND");
      }
      const file = await getPublicFileForDownload(id);
      if (!file) return sendError(reply, "File not found.", 404, "NOT_FOUND");

      const body = await readStreamToBuffer(file.stream);
      reply
        .code(200)
        .header("Content-Type", file.contentType)
        .header("Content-Length", String(body.length))
        .header("Cache-Control", "no-store, max-age=0")
        .header("Pragma", "no-cache")
        .header("Expires", "0")
        .header("Content-Disposition", `inline; filename="${encodeURIComponent(file.filename)}"`);
      return reply.send(body);
    } catch (e) {
      request.log.error({ err: e }, "file serve failed");
      return sendError(reply, clientErrorMessage(e, "Failed to serve file."), 500, "FILE_SERVE_FAILED");
    }
  });
}

