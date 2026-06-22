import type { FastifyInstance } from "fastify";

import { requireApiKey } from "../auth/requireApiKey.js";
import { resolveEmbedBackendModel } from "../constants/taskCatalog.js";
import { callOllamaEmbed } from "../ollama/callOllamaEmbed.js";
import { readOllamaEnv } from "../ollama/callOllamaChat.js";
import { embeddingBodySchema } from "../schemas/embeddingBody.js";

/** Proxies to Ollama `POST /api/embed` (same shape as `http://localhost:11434/api/embed`). */
export async function registerEmbeddingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/api/v1/embed", { preHandler: requireApiKey }, async (request, reply) => {
    const parsed = embeddingBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid body",
        issues: parsed.error.flatten(),
      });
    }

    const body = parsed.data;
    const model = body.model?.trim() || resolveEmbedBackendModel();
    const { baseUrl } = readOllamaEnv();

    try {
      const result = await callOllamaEmbed({
        baseUrl,
        model,
        input: body.input,
      });
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Embedding request failed.";
      return reply.code(502).send({
        message,
        code: "OLLAMA_EMBED_FAILED",
      });
    }
  });
}
