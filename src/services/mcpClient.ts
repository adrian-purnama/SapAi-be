import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const MCP_CLIENT_TIMEOUT_MS = 10_000;

export type McpConnectionSettings = {
  mcpUrl: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
};

export type McpToolSummary = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

function buildTransportRequestInit(settings: McpConnectionSettings): RequestInit {
  const bodyObj = settings.body ?? {};
  const hasBody = Object.keys(bodyObj).length > 0;
  return {
    headers: settings.headers,
    ...(hasBody ? { body: JSON.stringify(bodyObj) } : {}),
  };
}

export async function connectMcpClient(settings: McpConnectionSettings): Promise<Client> {
  const client = new Client({ name: "sapai", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(settings.mcpUrl), {
    requestInit: buildTransportRequestInit(settings),
  });
  await client.connect(transport, { timeout: MCP_CLIENT_TIMEOUT_MS });
  return client;
}

export async function listMcpTools(client: Client): Promise<McpToolSummary[]> {
  const { tools } = await client.listTools(undefined, { timeout: MCP_CLIENT_TIMEOUT_MS });
  return tools
    .filter((t) => typeof t.name === "string" && t.name.trim())
    .map((t) => ({
      name: t.name.trim(),
      description: typeof t.description === "string" ? t.description.trim() : undefined,
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object"
          ? (t.inputSchema as Record<string, unknown>)
          : undefined,
    }));
}

function formatToolResultContent(result: { content?: unknown }): string {
  const parts = Array.isArray(result.content) ? result.content : [];
  const texts = parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") return p.text;
      return JSON.stringify(part);
    })
    .filter(Boolean);
  if (texts.length > 0) return texts.join("\n");
  return JSON.stringify(result);
}

export async function callMcpTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await client.callTool(
    { name: toolName, arguments: args },
    undefined,
    { timeout: MCP_CLIENT_TIMEOUT_MS },
  );
  return formatToolResultContent(result as { content?: unknown });
}

export async function withMcpClient<T>(
  settings: McpConnectionSettings,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await connectMcpClient(settings);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export type McpToolProbe = { ok: true; tools: string[] } | { ok: false; error: string };

export async function probeMcpToolNames(
  settings: Pick<McpConnectionSettings, "mcpUrl" | "headers" | "body">,
): Promise<McpToolProbe> {
  try {
    const tools = await withMcpClient(
      {
        mcpUrl: settings.mcpUrl,
        headers: settings.headers,
        body: settings.body,
      },
      listMcpTools,
    );
    return { ok: true, tools: tools.map((t) => t.name) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "MCP probe failed." };
  }
}
