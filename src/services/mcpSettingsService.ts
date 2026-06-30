import mongoose, { type ClientSession } from "mongoose";

import { ApiKeyMcpSettingsModel } from "../models/ApiKeyMcpSettings.js";
import { getEffectivePlanForUserId } from "./planRegistry.js";
import { isAllowedMcpUrl, normalizeMcpBody, normalizeMcpHeaders } from "../utils/mcpSettingsValidation.js";

export const MCP_PLAN_REQUIRED = "MCP_PLAN_REQUIRED";

export type McpSettingsDto = {
  enabled: boolean;
  mcpUrl: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  mcpPlanEligible: boolean;
};

export type McpSettingsPatch = {
  enabled?: boolean;
  mcpUrl?: string;
  headers?: Record<string, unknown>;
  body?: Record<string, unknown>;
};

async function userPlanAllowsMcp(userId: mongoose.Types.ObjectId): Promise<boolean> {
  const plan = await getEffectivePlanForUserId(userId);
  return Boolean(plan?.allowMcp);
}

function docToDto(
  doc: {
    enabled?: boolean;
    mcpUrl?: string;
    headers?: unknown;
    body?: unknown;
  } | null,
  mcpPlanEligible: boolean,
): McpSettingsDto {
  let headers: Record<string, string> = {};
  let body: Record<string, unknown> = {};
  try {
    if (doc?.headers != null) headers = normalizeMcpHeaders(doc.headers);
  } catch {
    headers = {};
  }
  try {
    if (doc?.body != null) body = normalizeMcpBody(doc.body);
  } catch {
    body = {};
  }
  return {
    enabled: Boolean(doc?.enabled),
    mcpUrl: typeof doc?.mcpUrl === "string" ? doc.mcpUrl.trim() : "",
    headers,
    body,
    mcpPlanEligible,
  };
}

export async function getMcpSettings(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
): Promise<McpSettingsDto> {
  const [doc, mcpPlanEligible] = await Promise.all([
    ApiKeyMcpSettingsModel.findOne({ userId, apiKeyId }).lean(),
    userPlanAllowsMcp(userId),
  ]);
  return docToDto(doc, mcpPlanEligible);
}

export async function upsertMcpSettings(
  userId: mongoose.Types.ObjectId,
  apiKeyId: mongoose.Types.ObjectId,
  patch: McpSettingsPatch,
): Promise<McpSettingsDto> {
  const mcpPlanEligible = await userPlanAllowsMcp(userId);
  const existing = await ApiKeyMcpSettingsModel.findOne({ userId, apiKeyId });

  const nextEnabled = patch.enabled !== undefined ? patch.enabled : Boolean(existing?.enabled);
  const nextUrl =
    patch.mcpUrl !== undefined
      ? patch.mcpUrl.trim()
      : typeof existing?.mcpUrl === "string"
        ? existing.mcpUrl.trim()
        : "";
  const nextHeaders =
    patch.headers !== undefined
      ? normalizeMcpHeaders(patch.headers)
      : existing?.headers != null
        ? normalizeMcpHeaders(existing.headers)
        : {};
  const nextBody =
    patch.body !== undefined
      ? normalizeMcpBody(patch.body)
      : existing?.body != null
        ? normalizeMcpBody(existing.body)
        : {};

  if (nextEnabled && !mcpPlanEligible) {
    throw new Error(MCP_PLAN_REQUIRED);
  }
  if (nextEnabled && !nextUrl) {
    throw new Error("mcpUrl is required when MCP is enabled.");
  }
  if (nextUrl && !isAllowedMcpUrl(nextUrl)) {
    throw new Error("mcpUrl must be https or http://localhost / http://127.0.0.1.");
  }

  const doc =
    existing ??
    new ApiKeyMcpSettingsModel({
      userId,
      apiKeyId,
      enabled: false,
      mcpUrl: "",
      headers: {},
      body: {},
    });

  doc.enabled = nextEnabled;
  doc.mcpUrl = nextUrl;
  doc.set("headers", nextHeaders);
  doc.set("body", nextBody);
  await doc.save();

  return docToDto(doc, mcpPlanEligible);
}

export async function deleteMcpSettingsForApiKey(
  apiKeyId: mongoose.Types.ObjectId,
  session?: ClientSession,
): Promise<void> {
  await ApiKeyMcpSettingsModel.deleteOne({ apiKeyId }).session(session ?? null);
}
