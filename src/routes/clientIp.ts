import type { FastifyInstance } from "fastify";

import { requireBearerUser } from "../auth/requireBearerUser.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { firstHeaderValue } from "../utils/requestHeaders.js";

function parseForwardedFor(raw: string | null): string | null {
  if (!raw) return null;
  const first = raw.split(",")[0]?.trim();
  return first || null;
}

export async function registerClientIpRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/v1/client-ip", { preHandler: requireBearerUser }, async (request, reply) => {
    const xfwd = firstHeaderValue(request.headers["x-forwarded-for"]);
    const xreal = firstHeaderValue(request.headers["x-real-ip"]);
    const ip =
      parseForwardedFor(xfwd) ||
      (xreal?.trim() ? xreal.trim() : null) ||
      (request.ip?.trim() ? request.ip.trim() : null);
    return sendSuccess(reply, { ip });
  });
}
