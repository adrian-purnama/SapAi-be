import mongoose from "mongoose";

import { MAX_CHAT_INPUT_MESSAGES, RAG_SESSION_TTL_MS } from "../constants/chatLimits.js";
import { ChatSessionModel, type ChatSessionMessage } from "../models/ChatSession.js";
import type { ChatJobCreateBodyParsed, NormalizedChatJobCreateBody } from "../schemas/chatJobBody.js";
import { buildTranslatePrompt } from "../utils/buildTranslatePrompt.js";

export type ChatSessionPublic = {
  id: string;
  expiresAt: Date;
};

export class ChatSessionError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ChatSessionError";
    this.code = code;
  }
}

const OCR_MODE_LABELS: Record<"text" | "formula" | "table", string> = {
  text: "Text Recognition",
  formula: "Formula Recognition",
  table: "Table Recognition",
};

function sessionExpiresAt(from = new Date()): Date {
  return new Date(from.getTime() + RAG_SESSION_TTL_MS);
}

function trimSessionMessages(messages: ChatSessionMessage[]): ChatSessionMessage[] {
  return messages.slice(-MAX_CHAT_INPUT_MESSAGES);
}

export function toChatSessionPublic(doc: { _id: mongoose.Types.ObjectId; expiresAt: Date }): ChatSessionPublic {
  return { id: String(doc._id), expiresAt: doc.expiresAt };
}

export async function createChatSession(apiKeyId: string): Promise<ChatSessionPublic> {
  const doc = await ChatSessionModel.create({
    apiKeyId: new mongoose.Types.ObjectId(apiKeyId),
    status: "active",
    messages: [],
    expiresAt: sessionExpiresAt(),
  });
  return toChatSessionPublic(doc);
}

export async function assertActiveChatSession(apiKeyId: string, sessionId: string): Promise<ChatSessionPublic> {
  if (!mongoose.Types.ObjectId.isValid(sessionId)) {
    throw new ChatSessionError("Chat session not found.", "SESSION_NOT_FOUND");
  }

  const apiKeyOid = new mongoose.Types.ObjectId(apiKeyId);
  const sessionOid = new mongoose.Types.ObjectId(sessionId);
  const now = new Date();

  const doc = await ChatSessionModel.findOne({ _id: sessionOid, apiKeyId: apiKeyOid }).lean();
  if (!doc) {
    throw new ChatSessionError("Chat session not found.", "SESSION_NOT_FOUND");
  }
  if (doc.status === "ended") {
    throw new ChatSessionError("Chat session has ended.", "SESSION_ENDED");
  }
  if (!doc.expiresAt || doc.expiresAt.getTime() < now.getTime()) {
    throw new ChatSessionError("Chat session has expired.", "SESSION_EXPIRED");
  }

  const nextExpiresAt = sessionExpiresAt(now);
  await ChatSessionModel.updateOne({ _id: sessionOid }, { $set: { expiresAt: nextExpiresAt } });

  return { id: sessionId, expiresAt: nextExpiresAt };
}

export async function endChatSession(apiKeyId: string, sessionId: string): Promise<ChatSessionPublic> {
  if (!mongoose.Types.ObjectId.isValid(sessionId)) {
    throw new ChatSessionError("Chat session not found.", "SESSION_NOT_FOUND");
  }

  const apiKeyOid = new mongoose.Types.ObjectId(apiKeyId);
  const sessionOid = new mongoose.Types.ObjectId(sessionId);

  const doc = await ChatSessionModel.findOneAndUpdate(
    { _id: sessionOid, apiKeyId: apiKeyOid },
    { $set: { status: "ended" } },
    { new: true },
  ).lean();

  if (!doc) {
    throw new ChatSessionError("Chat session not found.", "SESSION_NOT_FOUND");
  }

  return toChatSessionPublic(doc);
}

export function chatSessionHttpStatus(code: string): number {
  if (code === "SESSION_NOT_FOUND") return 404;
  return 400;
}

export type ResolveChatSessionOptions = {
  apiKeyId: string;
  sessionId?: string;
  generateSessionId?: boolean;
  /** Embed chat: create when no sessionId supplied */
  autoCreate?: boolean;
};

export async function resolveChatSessionForJob(opts: ResolveChatSessionOptions): Promise<ChatSessionPublic | null> {
  const sid = opts.sessionId?.trim();
  if (opts.generateSessionId && sid) {
    throw new ChatSessionError("Use sessionId or generateSessionId, not both.", "SESSION_CONFLICT");
  }
  if (opts.generateSessionId) return createChatSession(opts.apiKeyId);
  if (sid) return assertActiveChatSession(opts.apiKeyId, sid);
  if (opts.autoCreate) return createChatSession(opts.apiKeyId);
  return null;
}

export function chatSessionToResponse(session: ChatSessionPublic) {
  return {
    session: {
      id: session.id,
      expiresAt: session.expiresAt.toISOString(),
    },
  };
}

export function getSessionIdFromRaw(raw: ChatJobCreateBodyParsed): string | undefined {
  return raw.sessionId;
}

export function getGenerateSessionIdFromRaw(raw: ChatJobCreateBodyParsed): boolean | undefined {
  return raw.generateSessionId;
}

export function extractUserTurn(
  raw: ChatJobCreateBodyParsed,
  _normalized: NormalizedChatJobCreateBody,
): string {
  if (raw.taskType === "translate") {
    return raw.text.trim();
  }
  if (raw.taskType === "ocr") {
    return OCR_MODE_LABELS[raw.mode ?? "text"];
  }
  const lastUser = [...raw.input].reverse().find((m) => m.role === "user");
  return (lastUser?.content ?? raw.input[raw.input.length - 1]?.content ?? "").trim();
}

export async function loadSessionMessages(sessionId: string): Promise<ChatSessionMessage[]> {
  const doc = await ChatSessionModel.findById(sessionId).select({ messages: 1 }).lean();
  if (!doc?.messages) return [];
  return doc.messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content ?? "").trim(),
  }));
}

export async function appendSessionUserMessage(sessionId: string, content: string): Promise<void> {
  const text = content.trim();
  if (!text) return;

  const doc = await ChatSessionModel.findById(sessionId).select({ messages: 1 }).lean();
  const next = trimSessionMessages([...(doc?.messages ?? []), { role: "user" as const, content: text }]);
  await ChatSessionModel.updateOne({ _id: sessionId }, { $set: { messages: next } });
}

export async function appendSessionAssistantMessage(sessionId: string, content: string): Promise<void> {
  const text = content.trim();
  if (!text) return;

  const doc = await ChatSessionModel.findById(sessionId).select({ messages: 1 }).lean();
  const next = trimSessionMessages([...(doc?.messages ?? []), { role: "assistant" as const, content: text }]);
  await ChatSessionModel.updateOne({ _id: sessionId }, { $set: { messages: next } });
}

function formatTranslateHistory(messages: ChatSessionMessage[]): string {
  if (messages.length <= 1) return "";
  const prior = messages.slice(0, -1);
  const lines = prior.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
  return `Previous conversation:\n${lines.join("\n")}\n\n`;
}

export function buildJobInputWithSession(
  raw: ChatJobCreateBodyParsed,
  normalized: NormalizedChatJobCreateBody,
  messages: ChatSessionMessage[],
): NormalizedChatJobCreateBody["input"] {
  if (raw.taskType === "chat" || raw.taskType === "rag") {
    return messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  if (raw.taskType === "translate") {
    const history = formatTranslateHistory(messages);
    const prompt = buildTranslatePrompt({
      sourceLang: raw.sourceLang,
      sourceCode: raw.sourceCode,
      targetLang: raw.targetLang,
      targetCode: raw.targetCode,
      text: raw.text,
    });
    return [{ role: "user", content: history ? `${history}${prompt}` : prompt }];
  }

  // ponytail: OCR — current image only; session is turn log
  return normalized.input;
}

export async function applySessionMemoryToJob(params: {
  sessionId: string;
  raw: ChatJobCreateBodyParsed;
  merged: NormalizedChatJobCreateBody;
}): Promise<NormalizedChatJobCreateBody["input"]> {
  const userTurn = extractUserTurn(params.raw, params.merged);
  await appendSessionUserMessage(params.sessionId, userTurn);
  const messages = await loadSessionMessages(params.sessionId);
  return buildJobInputWithSession(params.raw, params.merged, messages);
}
