import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireBearerUser } from "../auth/requireBearerUser.js";
import { probeMcpToolNames } from "../services/mcpClient.js";
import {
  getMcpSettings,
  MCP_PLAN_REQUIRED,
  upsertMcpSettings,
} from "../services/mcpSettingsService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { requireActiveOwnedApiKey } from "../utils/requireOwnedApiKey.js";

function mapOwnedApiKeyGate(reply: Parameters<typeof sendError>[0], gate: { ok: false; error: string; status: number }) {
  const code =
    gate.status === 403 ? "API_KEY_DISABLED" : gate.status === 400 ? "INVALID_ID" : "NOT_FOUND";
  return sendError(reply, gate.error, gate.status, code);
}

const mcpPatchBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    mcpUrl: z.string().max(2048).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required." });

export async function registerApiKeyMcpRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/v1/api-keys/:id/mcp", { preHandler: requireBearerUser }, async (request, reply) => {
    const user = request.bearerUser!;
    const id = String((request.params as { id?: string })?.id ?? "");
    const gate = await requireActiveOwnedApiKey(user._id, id);
    if (!gate.ok) {
      return mapOwnedApiKeyGate(reply, gate);
    }
    try {
      const settings = await getMcpSettings(user._id, gate.apiKeyOid);
      return sendSuccess(reply, settings);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load MCP settings.";
      return sendError(reply, message, 500, "MCP_GET_FAILED");
    }
  });

  fastify.patch("/api/v1/api-keys/:id/mcp", { preHandler: requireBearerUser }, async (request, reply) => {
    const user = request.bearerUser!;
    const id = String((request.params as { id?: string })?.id ?? "");
    const gate = await requireActiveOwnedApiKey(user._id, id);
    if (!gate.ok) {
      return mapOwnedApiKeyGate(reply, gate);
    }
    const parsed = mcpPatchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, parsed.error.issues[0]?.message ?? "Invalid body.", 400, "INVALID_BODY");
    }
    try {
      const settings = await upsertMcpSettings(user._id, gate.apiKeyOid, parsed.data);
      const toolTest =
        settings.enabled && settings.mcpUrl.trim()
          ? await probeMcpToolNames(settings)
          : undefined;
      return sendSuccess(reply, { ...settings, toolTest });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to update MCP settings.";
      if (msg === MCP_PLAN_REQUIRED) {
        return sendError(reply, "MCP is not included in your subscription plan.", 403, "MCP_PLAN_REQUIRED");
      }
      if (
        msg.includes("mcpUrl") ||
        msg.includes("headers") ||
        msg.includes("body") ||
        msg.includes("https") ||
        msg.includes("http")
      ) {
        return sendError(reply, msg, 400, "VALIDATION_ERROR");
      }
      return sendError(reply, msg, 500, "MCP_PATCH_FAILED");
    }
  });
}
