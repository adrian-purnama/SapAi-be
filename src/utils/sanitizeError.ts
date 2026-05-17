export function isProductionEnvironment(): boolean {
  const env = process.env.ENVIRONMENT?.trim().toLowerCase();
  return env === "production" || env === "prod";
}

/** User-facing message for 500 responses; hides internals in production. */
export function clientErrorMessage(err: unknown, fallback: string): string {
  if (!isProductionEnvironment()) {
    return err instanceof Error ? err.message : fallback;
  }
  return fallback;
}
