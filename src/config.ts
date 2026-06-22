import { stripQuotes } from "./utils/env.js";

export type AppConfig = {
  appName: string;
  environment: string;
  host: string;
  port: number;
  corsOrigins: string;
  mongodbUri: string | null;
  mongodbDbName: string | null;
  apiVersion: string;
};

/** Browser origins allowed to call this API (`@fastify/cors`). */
function resolveCorsOrigins(): string {
  const explicit = process.env.CORS_ORIGINS?.trim();
  if (explicit) return stripQuotes(explicit);

  const fallback = process.env.PUBLIC_APP_URL?.trim();
  if (fallback) return stripQuotes(fallback);

  return "http://localhost:3000";
}

export function loadConfig(): AppConfig {
  return {
    appName: stripQuotes(process.env.APP_NAME ?? "SapAi API"),
    environment: stripQuotes(process.env.ENVIRONMENT ?? "development"),
    host: stripQuotes(process.env.HOST ?? "0.0.0.0"),
    port: Number.parseInt(process.env.PORT ?? "8000", 10),
    corsOrigins: resolveCorsOrigins(),
    mongodbUri: process.env.MONGODB_URI?.trim() || null,
    mongodbDbName: process.env.MONGODB_DB_NAME?.trim() || null,
    apiVersion: "0.1.0",
  };
}
