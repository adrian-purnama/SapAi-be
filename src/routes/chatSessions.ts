import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import mongoose from "mongoose";

import { requireApiKey } from "../auth/requireApiKey.js";
import {
  createChatSession,
  endChatSession,
  ChatSessionError,
  chatSessionHttpStatus,
  chatSessionToResponse,
} from "../services/chatSessionService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";

function handleChatSessionError(reply: FastifyReply, err: unknown) {
  if (err instanceof ChatSessionError) {
    return sendError(reply, err.message, chatSessionHttpStatus(err.code), err.code);
  }
  throw err;
}

async function handleCreateChatSession(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.apiAuth!;
  try {
    const session = await createChatSession(auth.apiKeyId);
    return sendSuccess(reply, chatSessionToResponse(session), 201);
  } catch (err) {
    return handleChatSessionError(reply, err);
  }
}

async function handleEndChatSession(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const auth = request.apiAuth!;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return sendError(reply, "Chat session not found.", 404, "SESSION_NOT_FOUND");
  }
  try {
    const session = await endChatSession(auth.apiKeyId, id);
    return sendSuccess(reply, chatSessionToResponse(session));
  } catch (err) {
    return handleChatSessionError(reply, err);
  }
}

export async function registerChatSessionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/api/v1/chat-sessions", { preHandler: requireApiKey }, handleCreateChatSession);
  fastify.delete("/api/v1/chat-sessions/:id", { preHandler: requireApiKey }, handleEndChatSession);
}
