import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireBearerAdmin } from "../auth/requireBearerUser.js";
import { getPublicTaskCatalog } from "../constants/taskCatalog.js";
import { createPlan, deletePlan, getPlanById, listPlans, updatePlan } from "../services/plansService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { planCreateBodySchema, planPatchBodySchema } from "../validation/planSchemas.js";

export async function registerPlanRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/v1/admin/task-catalog", { preHandler: requireBearerAdmin }, async (_request, reply) => {
    return sendSuccess(reply, { catalog: getPublicTaskCatalog() });
  });

  fastify.get("/api/v1/admin/plans", { preHandler: requireBearerAdmin }, async (_request, reply) => {
    try {
      const plans = await listPlans();
      return sendSuccess(reply, { plans });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to list plans.";
      return sendError(reply, message, 500, "PLANS_LIST_FAILED");
    }
  });

  fastify.get("/api/v1/admin/plans/:id", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return sendError(reply, "Invalid plan id.", 400, "INVALID_PARAMS");

    try {
      const plan = await getPlanById(params.data.id);
      if (!plan) return sendError(reply, "Plan not found.", 404, "NOT_FOUND");
      return sendSuccess(reply, { plan });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load plan.";
      return sendError(reply, message, 500, "PLAN_FETCH_FAILED");
    }
  });

  fastify.post("/api/v1/admin/plans", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const body = planCreateBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, body.error.issues[0]?.message ?? "Invalid request body.", 400, "INVALID_BODY");
    }

    try {
      const plan = await createPlan(body.data);
      return sendSuccess(reply, { plan }, 201);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to create plan.";
      const code = message.includes("slug") ? "SLUG_EXISTS" : "PLAN_CREATE_FAILED";
      return sendError(reply, message, 400, code);
    }
  });

  fastify.patch("/api/v1/admin/plans/:id", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return sendError(reply, "Invalid plan id.", 400, "INVALID_PARAMS");

    const body = planPatchBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, body.error.issues[0]?.message ?? "Invalid request body.", 400, "INVALID_BODY");
    }

    try {
      const plan = await updatePlan(params.data.id, body.data);
      return sendSuccess(reply, { plan });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to update plan.";
      const status = message === "Plan not found." ? 404 : 400;
      const code = status === 404 ? "NOT_FOUND" : "PLAN_UPDATE_FAILED";
      return sendError(reply, message, status, code);
    }
  });

  fastify.delete("/api/v1/admin/plans/:id", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return sendError(reply, "Invalid plan id.", 400, "INVALID_PARAMS");

    try {
      await deletePlan(params.data.id);
      return sendSuccess(reply, { message: "Plan deleted." });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to delete plan.";
      const status = message === "Plan not found." ? 404 : 400;
      const code = status === 404 ? "NOT_FOUND" : "PLAN_DELETE_FAILED";
      return sendError(reply, message, status, code);
    }
  });
}
