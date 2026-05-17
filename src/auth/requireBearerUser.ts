import type { FastifyReply, FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { UserModel, type UserDocument } from "../models/User.js";
import { verifyAuthToken, type AuthTokenPayload } from "../services/jwtService.js";
import { sendError } from "../utils/apiResponse.js";

declare module "fastify" {
  interface FastifyRequest {
    bearerUser?: UserDocument;
  }
}

function getBearerToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (!auth) return null;
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

export async function requireBearerUser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = getBearerToken(request);
  if (!token) {
    void sendError(reply, "Authentication required.", 401, "UNAUTHORIZED");
    return;
  }

  if (mongoose.connection.readyState !== 1) {
    void sendError(reply, "MongoDB is not configured. Set MONGODB_URI in server/.env", 503, "MONGO_NOT_READY");
    return;
  }

  let payload: AuthTokenPayload;
  try {
    payload = verifyAuthToken(token);
  } catch {
    void sendError(reply, "Invalid or expired token.", 401, "INVALID_TOKEN");
    return;
  }

  const user = await UserModel.findById(payload.sub);
  if (!user) {
    void sendError(reply, "User not found.", 401, "USER_NOT_FOUND");
    return;
  }
  const tokenVersion = user.tokenVersion ?? 0;
  if (tokenVersion !== payload.tokenVersion) {
    void sendError(reply, "Invalid or expired token.", 401, "INVALID_TOKEN");
    return;
  }
  if (user.isBlocked) {
    void sendError(reply, "Account is blocked.", 403, "USER_BLOCKED");
    return;
  }

  request.bearerUser = user;
}

export async function requireBearerAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireBearerUser(request, reply);
  if (reply.sent) return;
  if (!request.bearerUser?.isAdmin) {
    void sendError(reply, "Admin access required.", 403, "FORBIDDEN");
  }
}

