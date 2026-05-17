import { z } from "zod";

import {
  MAX_CHAT_INPUT_MESSAGES,
  MAX_CHAT_MAX_TOKENS,
  MAX_CHAT_OUTPUT_JSON_TEMPLATE_CHARS,
} from "../constants/chatLimits.js";
import { ALLOWED_CHAT_MODEL_IDS } from "../constants/chatModels.js";

export const CHAT_TASK_TYPES = [
  "chat",
  "rag",
] as const;

const taskTypeEnum = z.enum(CHAT_TASK_TYPES);

// Clients send model *labels* (not raw Ollama ids). We map label -> model server-side.
const MODEL_LABELS = ALLOWED_CHAT_MODEL_IDS.map((m) => m.label) as unknown as [string, ...string[]];
const modelEnum = z.enum(MODEL_LABELS);

export const chatJobCreateBodySchema = z.object({
  taskType: taskTypeEnum,
  model: modelEnum,
  input: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.string().trim().min(1, "Message cannot be empty"),
      }),
    )
    .min(1, "At least one message is required")
    .max(MAX_CHAT_INPUT_MESSAGES),
  maxTokens: z.number().int().min(1).max(MAX_CHAT_MAX_TOKENS).optional(),
  /** When set, server prepends a synthetic system message derived from this JSON-shape template. */
  outputJsonTemplate: z.string().max(MAX_CHAT_OUTPUT_JSON_TEMPLATE_CHARS).optional(),
});

export type ChatJobCreateBody = z.infer<typeof chatJobCreateBodySchema>;
