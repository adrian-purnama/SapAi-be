import type { FastifyRequest } from "fastify";

import { getClientIp, headerString } from "../auth/requireApiKey.js";

export function readVisitorLocation(request: FastifyRequest): string | null {
  const cf = headerString(request.headers["cf-ipcountry"]);
  if (cf?.trim() && cf.trim() !== "XX") return cf.trim().toUpperCase();

  const vercel = headerString(request.headers["x-vercel-ip-country"]);
  if (vercel?.trim() && vercel.trim() !== "XX") return vercel.trim().toUpperCase();

  return null;
}

export function readEmbedVisitorIp(request: FastifyRequest): string | null {
  return getClientIp(request);
}
