import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";

import { requireApiKey } from "../auth/requireApiKey.js";
import { getPlanUsageLimitsForUser } from "../utils/planChatLimits.js";
import { isProductionEnvironment } from "../utils/sanitizeError.js";

export async function registerHealthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/health", async () => {
    if (isProductionEnvironment()) {
      const mongoOk = mongoose.connection.readyState === 1;
      return {
        ok: mongoOk,
        status: mongoOk ? "healthy" : "unhealthy",
      };
    }

    const cfg = fastify.config;
    const uptime_seconds =
      fastify.startedAtMonotonic !== undefined
        ? Number(((performance.now() - fastify.startedAtMonotonic) / 1000).toFixed(3))
        : null;

    const mongo_uri_configured = Boolean(cfg.mongodbUri?.trim());
    const mongo_database_name =
      mongoose.connection.db?.databaseName ?? cfg.mongodbDbName ?? null;

    const mongo_check: Record<string, unknown> = {
      configured: mongo_uri_configured,
      database: mongo_database_name,
      status: "not_configured",
      latency_ms: null,
      error: null,
    };

    let overall_ok = true;
    let status_label = "healthy";

    if (!mongo_uri_configured) {
      mongo_check.status = "not_configured";
    } else if (mongoose.connection.readyState !== 1) {
      mongo_check.status = "misconfigured";
      mongo_check.error = "MONGODB_URI is set but the database client did not initialize.";
      overall_ok = false;
      status_label = "unhealthy";
    } else {
      const t0 = performance.now();
      try {
        await mongoose.connection.db!.admin().command({ ping: 1 });
        mongo_check.status = "connected";
        mongo_check.latency_ms = Math.round((performance.now() - t0) * 100) / 100;
      } catch (exc: unknown) {
        mongo_check.status = "error";
        mongo_check.error = exc instanceof Error ? exc.message : String(exc);
        mongo_check.latency_ms = Math.round((performance.now() - t0) * 100) / 100;
        overall_ok = false;
        status_label = "degraded";
      }
    }

    return {
      ok: overall_ok,
      status: status_label,
      application: {
        name: cfg.appName,
        environment: cfg.environment,
        title: cfg.appName,
        version: cfg.apiVersion,
      },
      uptime_seconds,
      checks: {
        api: { status: "up" },
        mongodb: mongo_check,
      },
    };
  });

  fastify.get("/test", async () => ({ ok: true, message: "Hello, World!" }));

  fastify.get("/test/api-key", { preHandler: requireApiKey }, async (request) => {
    const a = request.apiAuth!;
    const limits = await getPlanUsageLimitsForUser(a.userId);
    return {
      ok: true,
      apiLabel: a.label,
      currentPlan: limits.plan?.name ?? null,
      rateLimitPerMinute: limits.rateLimitPerMinute,
      maxCharacterPerMessage: limits.maxCharacterPerMessage,
    };
  });
}
