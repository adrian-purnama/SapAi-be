import type { FastifyRequest } from "fastify";

import { firstHeader } from "./requestHeaders.js";

/** Public site origin for absolute URLs (honors PUBLIC_BASE_URL, else forwarded Host). */
export function getPublicOriginFromRequest(request: FastifyRequest): string | null {
  const envBase = process.env.PUBLIC_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/$/, "");

  const proto =
    firstHeader(request.headers["x-forwarded-proto"])?.split(",")[0]?.trim() ||
    (request.protocol as string | undefined) ||
    "http";
  const host =
    firstHeader(request.headers["x-forwarded-host"])?.split(",")[0]?.trim() ||
    firstHeader(request.headers.host)?.trim() ||
    null;
  if (!host) return null;
  return `${proto}://${host}`;
}

export function toAbsoluteUrlFromRequest(request: FastifyRequest, maybePath: string | null): string | null {
  if (!maybePath) return null;
  const raw = maybePath.trim();
  if (!raw) return null;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  const origin = getPublicOriginFromRequest(request);
  if (!origin) return raw;
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return `${origin}${path}`;
}
