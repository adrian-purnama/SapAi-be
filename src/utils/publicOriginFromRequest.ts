import type { FastifyRequest } from "fastify";

function firstHeaderValue(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return null;
}

/** Public site origin for absolute URLs (honors PUBLIC_BASE_URL, else forwarded Host). */
export function getPublicOriginFromRequest(request: FastifyRequest): string | null {
  const envBase = process.env.PUBLIC_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/$/, "");

  const proto =
    firstHeaderValue(request.headers["x-forwarded-proto"])?.split(",")[0]?.trim() ||
    (request.protocol as string | undefined) ||
    "http";
  const host =
    firstHeaderValue(request.headers["x-forwarded-host"])?.split(",")[0]?.trim() ||
    firstHeaderValue(request.headers.host)?.trim() ||
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
