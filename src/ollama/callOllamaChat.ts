/**
 * Calls Ollama HTTP API (`POST /api/chat`).
 * Qwen 3 and other “thinking” models put reasoning in `message.thinking` and the answer in
 * `message.content`; thinking can be enabled by default unless `think: false` is sent.
 * @see https://docs.ollama.com/capabilities/thinking
 * @see https://github.com/ollama/ollama/blob/main/docs/api.md
 */

export type OllamaChatMessage = { role: string; content: string };

export type CallOllamaChatParams = {
  baseUrl: string;
  model: string;
  messages: OllamaChatMessage[];
  temperature: number;
  /** Maps to Ollama `options.num_predict`. */
  maxTokens: number;
  /** When false (default), sends `think: false` so answers usually land in `message.content`. */
  think: boolean;
};

export type CallOllamaChatResult = {
  text: string;
  promptTokens: number;
  completionTokens: number;
};

/** Trim trailing slash from base (e.g. http://localhost:11434). */
function joinOllamaChatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/chat`;
}

/** Prefer final answer; fallback to reasoning trace if content is empty (thinking models). */
function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as Record<string, unknown>;
  const content = typeof m.content === "string" ? m.content.trim() : "";
  const thinking = typeof m.thinking === "string" ? m.thinking.trim() : "";
  if (content) return content;
  if (thinking) return thinking;
  return "";
}

export async function callOllamaChat(params: CallOllamaChatParams): Promise<CallOllamaChatResult> {
  const url = joinOllamaChatUrl(params.baseUrl);
  /** Shape aligned with working curl: root `temperature`, `stream`, plus explicit `think`. */
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    stream: false,
    temperature: params.temperature,
    think: params.think,
    options: {
      num_predict: params.maxTokens,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Ollama ${res.status} at ${url}: ${raw.slice(0, 800)}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Ollama returned non-JSON: ${raw.slice(0, 300)}`);
  }

  const obj = data as {
    message?: unknown;
    prompt_eval_count?: number;
    eval_count?: number;
  };

  const text = extractAssistantText(obj.message);
  const promptTokens =
    typeof obj.prompt_eval_count === "number" && Number.isFinite(obj.prompt_eval_count)
      ? obj.prompt_eval_count
      : 0;
  const completionTokens =
    typeof obj.eval_count === "number" && Number.isFinite(obj.eval_count) ? obj.eval_count : 0;

  return {
    text,
    promptTokens,
    completionTokens,
  };
}

export function readOllamaEnv(): { baseUrl: string; temperature: number; think: boolean } {
  const baseUrl = process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434";
  const t = Number.parseFloat(process.env.OLLAMA_TEMPERATURE ?? "0.2");
  const thinkRaw = process.env.OLLAMA_THINK?.trim().toLowerCase();
  const think = thinkRaw === "true" || thinkRaw === "1";
  return {
    baseUrl,
    temperature: Number.isFinite(t) ? t : 0.2,
    think,
  };
}
