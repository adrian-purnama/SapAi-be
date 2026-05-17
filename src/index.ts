import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import mongoose from "mongoose";

import { shutdownRateLimitRedis } from "./auth/rateLimitStore.js";
import { loadConfig } from "./config.js";
import { startChatJobRunner, stopChatJobRunner } from "./jobs/chatJobRunner.js";
import { releaseStaleRunningChatJobs } from "./jobs/releaseStaleRunningChatJobs.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerEmbedRoutes } from "./routes/embed.js";
import { registerEmbeddingRoutes } from "./routes/embedding.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerApiKeyRoutes } from "./routes/apiKeys.js";
import { registerFaqConstantRoutes } from "./routes/faqConstants.js";
import { registerFaqDocumentRoutes } from "./routes/faqDocuments.js";
import { registerClientIpRoutes } from "./routes/clientIp.js";
import { registerAppConfigRoutes } from "./routes/appConfig.js";
import { registerFilesRoutes } from "./routes/files.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerAdminApiKeyRoutes } from "./routes/adminApiKeys.js";
import { resolveOllamaEmbedModel } from "./ollama/callOllamaEmbed.js";
import { reloadPlanRegistry } from "./services/planRegistry.js";
import { clientErrorMessage, isProductionEnvironment } from "./utils/sanitizeError.js";

let staleRunningChatJobsSweep: ReturnType<typeof setInterval> | null = null;

const JSON_BODY_LIMIT = Number(process.env.JSON_BODY_LIMIT_BYTES ?? 262_144);

function parseCorsOrigins(raw: string): boolean | string[] {
  const s = raw.trim();
  if (s === "*") return true;
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const trustProxy = process.env.TRUST_PROXY === "true";
  const fastify = Fastify({
    logger: true,
    bodyLimit: JSON_BODY_LIMIT,
    trustProxy,
  });

  fastify.decorate("config", config);
  fastify.decorate("startedAtMonotonic", performance.now());

  fastify.setErrorHandler((err, request, reply) => {
    request.log.error({ err }, "unhandled route error");
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    const message =
      status >= 500
        ? clientErrorMessage(err, "Internal server error.")
        : (e.message ?? "Request failed.");
    void reply.code(status).send({
      success: false,
      message,
      code: status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
    });
  });

  await fastify.register(cors, {
    origin: parseCorsOrigins(config.corsOrigins),
    credentials: config.corsOrigins.trim() !== "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "x-api-key", "x-embed-token"],
  });
  await fastify.register(multipart, {
    limits: {
      fileSize: Number(process.env.MULTIPART_MAX_FILE_BYTES ?? 16 * 1024 * 1024),
      files: 1,
    },
  });

  if (config.mongodbUri) {
    await mongoose.connect(config.mongodbUri, {
      dbName: config.mongodbDbName ?? undefined,
    });
    await reloadPlanRegistry();
    const ollamaBase = process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434";
    const embedModel = await resolveOllamaEmbedModel(ollamaBase);
    console.info("[sapai-server] Ollama embed model:", embedModel);
    startChatJobRunner();
    void releaseStaleRunningChatJobs();
  }

  fastify.addHook("onClose", async () => {
    if (staleRunningChatJobsSweep) {
      clearInterval(staleRunningChatJobsSweep);
      staleRunningChatJobsSweep = null;
    }
    stopChatJobRunner();
    await shutdownRateLimitRedis();
    await mongoose.disconnect();
  });

  await registerHealthRoutes(fastify);
  await registerAuthRoutes(fastify);
  await registerApiKeyRoutes(fastify);
  await registerFaqDocumentRoutes(fastify);
  await registerFaqConstantRoutes(fastify);
  await registerClientIpRoutes(fastify);
  await registerAppConfigRoutes(fastify);
  await registerFilesRoutes(fastify);
  await registerUserRoutes(fastify);
  await registerPlanRoutes(fastify);
  await registerAdminApiKeyRoutes(fastify);
  await registerEmbedRoutes(fastify);
  await registerChatRoutes(fastify);
  await registerEmbeddingRoutes(fastify);

  if (isProductionEnvironment() && !process.env.JWT_SECRET?.trim()) {
    throw new Error("JWT_SECRET is required in production.");
  }

  await fastify.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
