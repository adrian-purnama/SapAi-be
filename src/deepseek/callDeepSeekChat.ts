/**
 * DeepSeek OpenAI-compatible chat completions (`POST /v1/chat/completions`).
 * @see https://api-docs.deepseek.com/
 */

export type DeepSeekChatMessage = { role: string; content: string };

export type CallDeepSeekChatParams = {
  messages: DeepSeekChatMessage[];
  temperature: number;
  maxTokens: number;
};

export type CallDeepSeekChatResult = {
  text: string;
  promptTokens: number;
  completionTokens: number;
};

export function readDeepSeekChatModel(): string {
  return process.env.DEEPSEEK_CHAT_MODEL?.trim() || "deepseek-chat";
}

export function readDeepSeekApiKey(): string | null {
  const k = process.env.DEEPSEEK_API_KEY?.trim();
  return k && k.length > 0 ? k : null;
}

export async function callDeepSeekChat(params: CallDeepSeekChatParams): Promise<CallDeepSeekChatResult> {
  const apiKey = readDeepSeekApiKey();
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not set");
  }
  const base = (process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/$/, "");
  const model = readDeepSeekChatModel();
  const url = `${base}/v1/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: params.messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`DeepSeek ${res.status} at ${url}: ${raw.slice(0, 800)}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`DeepSeek returned non-JSON: ${raw.slice(0, 300)}`);
  }

  const o = data as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const content = o.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : "";
  const promptTokens =
    typeof o.usage?.prompt_tokens === "number" && Number.isFinite(o.usage.prompt_tokens)
      ? o.usage.prompt_tokens
      : 0;
  const completionTokens =
    typeof o.usage?.completion_tokens === "number" && Number.isFinite(o.usage.completion_tokens)
      ? o.usage.completion_tokens
      : 0;

  return { text, promptTokens, completionTokens };
}
