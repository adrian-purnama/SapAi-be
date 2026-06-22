/**
 * Ollama embeddings API: `POST /api/embed`
 * @see https://github.com/ollama/ollama/blob/main/docs/api.md
 */

import { resolveEmbedBackendModel, MODELS } from "../constants/taskCatalog.js";

export type CallOllamaEmbedParams = {
  baseUrl: string;
  model: string;
  input: string | string[];
};

export type OllamaEmbedResponse = {
  model: string;
  embeddings: number[][];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
};

function joinOllamaEmbedUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/embed`;
}

let cachedResolvedEmbedModel: string | null = null;

export async function listOllamaModelNames(baseUrl: string): Promise<string[]> {
  const root = baseUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${root}/api/tags`);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name?: string }[] };
    return (data.models ?? [])
      .map((m) => (typeof m.name === "string" ? m.name.trim() : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Maps catalog embed model to a name Ollama actually has (e.g. `qwen3-embedding` → `qwen3-embedding:4b`). */
export async function resolveOllamaEmbedModel(
  baseUrl: string,
  preferred = resolveEmbedBackendModel(),
): Promise<string> {
  if (cachedResolvedEmbedModel) return cachedResolvedEmbedModel;

  const want = preferred.trim() || resolveEmbedBackendModel();
  const names = await listOllamaModelNames(baseUrl);

  if (names.length === 0) {
    cachedResolvedEmbedModel = want;
    return want;
  }

  if (names.includes(want)) {
    cachedResolvedEmbedModel = want;
    return want;
  }

  const stripLatest = (n: string) => n.replace(/:latest$/i, "");
  const wantBase = stripLatest(want);
  const byBase = names.find((n) => stripLatest(n) === wantBase);
  if (byBase) {
    console.info("[ollama] Resolved embed model", { configured: want, using: byBase });
    cachedResolvedEmbedModel = byBase;
    return byBase;
  }

  const family = want.includes(":") ? want.split(":")[0]! : want;
  const familyMatch = names.find((n) => n === family || n.startsWith(`${family}:`));
  if (familyMatch) {
    console.info("[ollama] Resolved embed model family", { configured: want, using: familyMatch });
    cachedResolvedEmbedModel = familyMatch;
    return familyMatch;
  }

  const nomic = names.find((n) => /nomic-embed/i.test(n));
  if (nomic) {
    console.warn("[ollama] Embed model not in `ollama list`; falling back to", nomic, { configured: want });
    cachedResolvedEmbedModel = nomic;
    return nomic;
  }

  cachedResolvedEmbedModel = want;
  return want;
}

export async function callOllamaEmbed(params: CallOllamaEmbedParams): Promise<OllamaEmbedResponse> {
  const url = joinOllamaEmbedUrl(params.baseUrl);
  const model = await resolveOllamaEmbedModel(params.baseUrl, params.model);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: params.input,
    }),
  });

  const rawText = await res.text();
  let body: unknown;
  try {
    body = rawText ? JSON.parse(rawText) : {};
  } catch {
    throw new Error(`Ollama embed returned non-JSON (${res.status}): ${rawText.slice(0, 200)}`);
  }

  if (!res.ok) {
    const msg =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error?: string }).error ?? res.statusText)
        : res.statusText;
    if (res.status === 404 && /not found/i.test(msg)) {
      const available = await listOllamaModelNames(params.baseUrl);
      const hint =
        available.length > 0
          ? ` Available models: ${available.join(", ")}. Update MODELS.EMBED.id in taskCatalog.ts to match \`ollama list\`.`
          : ` Check \`ollama list\` and set MODELS.EMBED.id in taskCatalog.ts (currently ${MODELS.EMBED.id}).`;
      throw new Error(`Ollama embed failed (${res.status}): ${msg}${hint}`);
    }
    throw new Error(`Ollama embed failed (${res.status}): ${msg}`);
  }

  const o = body as Partial<OllamaEmbedResponse>;
  if (!o.model || !Array.isArray(o.embeddings)) {
    throw new Error("Ollama embed response missing model or embeddings.");
  }

  return o as OllamaEmbedResponse;
}

/**
 * Max characters per embed API input. Token limits vary by model (e.g. qwen3-embedding is strict);
 * character cap avoids `input length exceeds the context length` from Ollama.
 */
export function readOllamaEmbedMaxChars(): number {
  const raw = process.env.OLLAMA_EMBED_MAX_CHARS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 128 && n <= 8000) return n;
  }
  return 512;
}
