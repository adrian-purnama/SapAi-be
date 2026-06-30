export type RagAnalysisLike = {
  category?: string | null;
  answerable?: string | null;
  intent?: string | null;
} | null;

export type MappedRagAnalysis = {
  category: string | null;
  answerable: string | null;
  intent: string | null;
};

export function toIso(d: unknown): string | null {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(String(d));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

export function mapRagAnalysis(ra: RagAnalysisLike): MappedRagAnalysis | null {
  if (!ra || typeof ra !== "object") return null;
  return {
    category: ra.category ?? null,
    answerable: ra.answerable ?? null,
    intent: ra.intent ?? null,
  };
}
