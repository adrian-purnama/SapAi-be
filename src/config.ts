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

export function loadConfig(): AppConfig {
  return {
    appName: stripQuotes(process.env.APP_NAME ?? "SapAi API"),
    environment: stripQuotes(process.env.ENVIRONMENT ?? "development"),
    host: stripQuotes(process.env.HOST ?? "0.0.0.0"),
    port: Number.parseInt(process.env.PORT ?? "8000", 10),
    corsOrigins: stripQuotes(process.env.CORS_ORIGINS ?? "http://localhost:3000"),
    mongodbUri: process.env.MONGODB_URI?.trim() || null,
    mongodbDbName: process.env.MONGODB_DB_NAME?.trim() || null,
    apiVersion: "0.1.0",
  };
}
