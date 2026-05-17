import type { FastifyInstance } from "fastify";

import { requireBearerAdmin } from "../auth/requireBearerUser.js";
import { syncAllUsersApiKeysToPlans } from "../services/apiKeyPlanSyncService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";

export async function registerAdminApiKeyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    "/api/v1/admin/api-keys/sync-plans",
    { preHandler: requireBearerAdmin },
    async (_request, reply) => {
      try {
        const result = await syncAllUsersApiKeysToPlans();
        return sendSuccess(reply, result);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to sync API keys.";
        return sendError(reply, message, 500, "API_KEY_SYNC_FAILED");
      }
    },
  );
}
