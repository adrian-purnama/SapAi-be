import { callOllamaChat } from "../ollama/callOllamaChat.js";
import type { McpToolSummary } from "../services/mcpClient.js";

const ROUTER_MAX_TOKENS = 384;

export type McpRouterDecision =
  | { action: "none" }
  | { action: "clarify"; tool: string; message: string; missing: string[] }
  | { action: "call"; tool: string; args: Record<string, unknown> };

export type RouteMcpToolsParams = {
  baseUrl: string;
  model: string;
  temperature: number;
  messages: Array<{ role: string; content: string }>;
  tools: McpToolSummary[];
};

function extractBalancedJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
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

function formatConversation(messages: Array<{ role: string; content: string }>): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.trim()}`)
    .join("\n");
}

function formatToolsBlock(tools: McpToolSummary[]): string {
  return tools
    .map((t) => {
      const schema =
        t.inputSchema && Object.keys(t.inputSchema).length > 0
          ? JSON.stringify(t.inputSchema)
          : "{}";
      const desc = t.description ? ` — ${t.description}` : "";
      return `- ${t.name}${desc}\n  inputSchema: ${schema}`;
    })
    .join("\n");
}

function buildRouterSystemPrompt(tools: McpToolSummary[]): string {
  const toolNames = tools.map((t) => JSON.stringify(t.name)).join(", ");
  return (
    "You route user requests to at most one external MCP tool. Reply with ONE JSON object only — no markdown fences.\n" +
    "Available tools:\n" +
    formatToolsBlock(tools) +
    "\n\n" +
    "Output shapes (pick exactly one):\n" +
    '- {"action":"none"} — no tool matches the user intent.\n' +
    '- {"action":"clarify","tool":"<name>","message":"<short question>","missing":["field",...]} — tool fits but required arguments are missing; ask the user naturally.\n' +
    '- {"action":"call","tool":"<name>","args":{...}} — all required arguments are present; extract values from the full conversation.\n' +
    "\nRules:\n" +
    `- tool must be one of: ${toolNames}\n` +
    "- Extract argument values from the entire conversation, not only the last message.\n" +
    "- Never invent argument values.\n" +
    "- If required schema fields are missing, use clarify, not call.\n" +
    "- message should be one short sentence the assistant can show the user."
  );
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x).trim()).filter(Boolean);
}

function asArgsObject(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/** Parse router JSON; returns null when invalid. Exported for self-check. */
export function parseMcpRouterDecision(raw: unknown, allowedTools: string[]): McpRouterDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const action = typeof rec.action === "string" ? rec.action.trim().toLowerCase() : "";

  if (action === "none") return { action: "none" };

  const tool = typeof rec.tool === "string" ? rec.tool.trim() : "";
  if (!tool || !allowedTools.includes(tool)) return null;

  if (action === "clarify") {
    const message = typeof rec.message === "string" ? rec.message.trim() : "";
    if (!message) return null;
    return { action: "clarify", tool, message, missing: asStringArray(rec.missing) };
  }

  if (action === "call") {
    const args = asArgsObject(rec.args);
    if (!args) return null;
    return { action: "call", tool, args };
  }

  return null;
}

export async function routeMcpTools(params: RouteMcpToolsParams): Promise<McpRouterDecision> {
  if (params.tools.length === 0) return { action: "none" };

  const allowedTools = params.tools.map((t) => t.name);
  const conversation = formatConversation(params.messages);
  if (!conversation.trim()) return { action: "none" };

  const out = await callOllamaChat({
    baseUrl: params.baseUrl,
    model: params.model,
    messages: [
      { role: "system", content: buildRouterSystemPrompt(params.tools) },
      { role: "user", content: `Conversation:\n${conversation}` },
    ],
    temperature: Math.min(0.15, params.temperature),
    maxTokens: ROUTER_MAX_TOKENS,
    think: false,
  });

  const jsonStr = extractBalancedJsonObject(out.text.trim());
  if (!jsonStr) return { action: "none" };

  try {
    const parsed = parseMcpRouterDecision(JSON.parse(jsonStr) as unknown, allowedTools);
    return parsed ?? { action: "none" };
  } catch {
    return { action: "none" };
  }
}
