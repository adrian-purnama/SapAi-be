import type { FastifyInstance } from "fastify";

import { requireBearerUser } from "../auth/requireBearerUser.js";
import { getClientIp } from "../auth/requireApiKey.js";
import { sendSuccess } from "../utils/apiResponse.js";

export async function registerClientIpRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/v1/client-ip", { preHandler: requireBearerUser }, async (request, reply) => {
    const ip = getClientIp(request);
    return sendSuccess(reply, { ip });
  });
}
