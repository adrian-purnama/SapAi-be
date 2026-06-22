import type { FastifyReply } from "fastify";

export type ApiSuccess<T> = { success: true; data: T; error: null };
export type ApiFailure = {
  success: false;
  data: null | Record<string, unknown>;
  error: { message: string; code: string };
};

export function sendSuccess<T>(reply: FastifyReply, data: T, statusCode = 200) {
  const body: ApiSuccess<T> = { success: true, data, error: null };
  return reply.code(statusCode).send(body);
}

export function sendError(
  reply: FastifyReply,
  message: string,
  statusCode: number,
  code: string,
  data: Record<string, unknown> | null = null,
) {
  const body: ApiFailure = { success: false, data, error: { message, code } };
  return reply.code(statusCode).send(body);
}

