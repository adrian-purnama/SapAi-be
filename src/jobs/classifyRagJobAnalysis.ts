import { callOllamaChat } from "../ollama/callOllamaChat.js";
import type { FaqChunkHit } from "../qdrant/faqChunks.js";

const CLASSIFY_MAX_TOKENS = 256;
const PREVIEW_CHARS = 420;

export type ClassifyRagJobAnalysisParams = {
  baseUrl: string;
  model: string;
  temperature: number;
  question: string;
  assistantAnswer: string;
  retrievalHits: FaqChunkHit[];
  allowedCategories: string[];
  /** Must match `ChatJob.ragAnalysis.answerable` enum (e.g. `FAQ_ANSWERABLE_VALUES`). */
  allowedAnswerable: string[];
  /** Must match `ChatJob.ragAnalysis.intent` enum (e.g. `FAQ_INTENT_VALUES`). */
  allowedIntent: string[];
};

export type ClassifyRagJobAnalysisResult = {
  category: string | null;
  answerable: string;
  intent: string;
  promptTokens: number;
  completionTokens: number;
};

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function extractBalancedJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (c === "\\") {
        esc = true;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeAnswerable(raw: unknown, allowed: string[]): string {
  if (allowed.length === 0) return "unclear";
  const norm = allowed.map((a) => a.toLowerCase());
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const idx = norm.indexOf(s);
  if (idx >= 0) return allowed[idx]!;
  const unclear = allowed.find((a) => a.toLowerCase() === "unclear");
  return unclear ?? allowed[0]!;
}

function normalizeIntent(raw: unknown, allowed: string[]): string {
  if (allowed.length === 0) return "what_is";
  const norm = allowed.map((a) => a.toLowerCase());
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const idx = norm.indexOf(s);
  if (idx >= 0) return allowed[idx]!;
  const whatIs = allowed.find((a) => a.toLowerCase() === "what_is");
  return whatIs ?? allowed[0]!;
}

function normalizeCategory(raw: unknown, allowed: string[]): string | null {
  if (allowed.length === 0) return null;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t.toLowerCase() === "none" || t.toLowerCase() === "null") return null;
  const exact = allowed.find((a) => a === t);
  if (exact) return exact;
  const lower = t.toLowerCase();
  const ci = allowed.find((a) => a.toLowerCase() === lower);
  return ci ?? null;
}

function buildRetrievalSummary(hits: FaqChunkHit[]): string {
  if (hits.length === 0) return "(no FAQ chunks retrieved)";
  return hits
    .map((h, i) => {
      const preview = truncate(h.text, PREVIEW_CHARS).replace(/\s+/g, " ");
      return `[#${i + 1}] score=${typeof h.score === "number" ? h.score.toFixed(4) : "?"} len_chars=${h.text.length}\ntext_preview: ${preview}`;
    })
    .join("\n\n");
}

function buildSystemPrompt(allowedCategories: string[], allowedAnswerable: string[], allowedIntent: string[]): string {
  const catBlock =
    allowedCategories.length > 0
      ? `Allowed category values (pick exactly one string from this list, or "none" if none apply):\n${allowedCategories.map((c) => `- ${JSON.stringify(c)}`).join("\n")}\n`
      : "There are no project FAQ categories configured. Set category to \"none\".\n";

  const answerableBlock =
    allowedAnswerable.length > 0
      ? `Allowed answerable values (pick exactly one):\n${allowedAnswerable.map((a) => `- ${JSON.stringify(a)}`).join("\n")}\n`
      : "";

  const intentBlock =
    allowedIntent.length > 0
      ? `Allowed intent values (pick exactly one):\n${allowedIntent.map((a) => `- ${JSON.stringify(a)}`).join("\n")}\n`
      : "";

  return (
    "You classify a single user FAQ / RAG turn for analytics. Reply with ONE JSON object only   no markdown fences, no commentary.\n" +
    "Keys and semantics:\n" +
    "category: string" +
    (allowedCategories.length > 0
      ? "one of the allowed category strings above, or the literal \"none\"."
      : "always the literal \"none\".") +
    "\n" +
    "- answerable: string   whether the assistant answer addresses the user question using the retrieval context as evidence (yes=no gaps; partial=some gaps; no=does not answer; unclear=ambiguous or empty answer). Must be exactly one allowed answerable value.\n" +
    "- intent: string   the user's primary information need. Must be exactly one allowed intent value.\n" +
    "\n" +
    answerableBlock +
    intentBlock +
    catBlock +
    "Use retrieval scores only as weak evidence (high score does not mean the answer is correct)."
  );
}

function buildUserPayload(params: ClassifyRagJobAnalysisParams): string {
  return [
    "USER_QUESTION:",
    params.question || "(empty)",
    "",
    "ASSISTANT_ANSWER:",
    params.assistantAnswer || "(empty)",
    "",
    "RETRIEVAL:",
    buildRetrievalSummary(params.retrievalHits),
  ].join("\n");
}

/**
 * Second Ollama call: JSON classification for `ChatJob.ragAnalysis` (category / answerable / intent).
 * Returns null if the model response could not be parsed into valid fields (caller may fall back).
 */
export async function classifyRagJobAnalysis(
  params: ClassifyRagJobAnalysisParams,
): Promise<ClassifyRagJobAnalysisResult | null> {
  const allowedCat = params.allowedCategories.map((c) => (typeof c === "string" ? c.trim() : "")).filter(Boolean);
  const allowedAns = params.allowedAnswerable.map((c) => (typeof c === "string" ? c.trim() : "")).filter(Boolean);
  const allowedInt = params.allowedIntent.map((c) => (typeof c === "string" ? c.trim() : "")).filter(Boolean);
  const sys = buildSystemPrompt(allowedCat, allowedAns, allowedInt);
  const user = buildUserPayload(params);

  const out = await callOllamaChat({
    baseUrl: params.baseUrl,
    model: params.model,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: Math.min(0.15, params.temperature),
    maxTokens: CLASSIFY_MAX_TOKENS,
    think: false,
  });

  const raw = out.text.trim();
  const jsonStr = extractBalancedJsonObject(raw);
  if (!jsonStr) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(jsonStr) as unknown;
  } catch {
    return null;
  }

  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;

  const category = normalizeCategory(rec.category, allowedCat);
  const answerable = normalizeAnswerable(rec.answerable, allowedAns);
  const intent = normalizeIntent(rec.intent, allowedInt);

  return {
    category,
    answerable,
    intent,
    promptTokens: out.promptTokens,
    completionTokens: out.completionTokens,
  };
}
