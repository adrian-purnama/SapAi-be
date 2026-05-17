import "dotenv/config";

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

function stripQuotes(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Browser origins allowed to call this API (`@fastify/cors`). */
function resolveCorsOrigins(): string {
  const explicit = process.env.CORS_ORIGINS?.trim();
  if (explicit) return stripQuotes(explicit);

  const fromFrontend =
    process.env.FE_LINK?.trim() ||
    process.env.FRONTEND_URL?.trim() ||
    process.env.PUBLIC_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (fromFrontend) return stripQuotes(fromFrontend);

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
