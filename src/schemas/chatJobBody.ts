import { z } from "zod";

import {
  MAX_CHAT_INPUT_MESSAGES,
  MAX_CHAT_MAX_TOKENS,
  MAX_CHAT_OUTPUT_JSON_TEMPLATE_CHARS,
} from "../constants/chatLimits.js";
import {
  CHAT_TASK_TYPES,
  modelLabelsForTask,
  TRANSLATE_JOB_MODEL_LABEL,
} from "../constants/taskCatalog.js";
import { buildTranslatePrompt } from "../utils/buildTranslatePrompt.js";
import { assertTranslateTextWithinPlanLimits } from "../utils/planChatLimits.js";

export { CHAT_TASK_TYPES };

function labelsToEnum(labels: string[]) {
  if (labels.length === 0) {
    throw new Error("taskCatalog: task has no model labels");
  }
  return z.enum(labels as unknown as [string, ...string[]]);
}

const chatModelEnum = labelsToEnum(modelLabelsForTask("chat"));
const ragModelEnum = labelsToEnum(modelLabelsForTask("rag"));

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().trim().min(1, "Message cannot be empty"),
});

const chatBodySchema = z.object({
  taskType: z.literal("chat"),
  model: chatModelEnum,
  input: z
    .array(chatMessageSchema)
    .min(1, "At least one message is required")
    .max(MAX_CHAT_INPUT_MESSAGES),
  maxTokens: z.number().int().min(1).max(MAX_CHAT_MAX_TOKENS).optional(),
  outputJsonTemplate: z.string().max(MAX_CHAT_OUTPUT_JSON_TEMPLATE_CHARS).optional(),
});

const ragBodySchema = z.object({
  taskType: z.literal("rag"),
  model: ragModelEnum,
  input: z
    .array(chatMessageSchema)
    .min(1, "At least one message is required")
    .max(MAX_CHAT_INPUT_MESSAGES),
  maxTokens: z.number().int().min(1).max(MAX_CHAT_MAX_TOKENS).optional(),
  outputJsonTemplate: z.string().max(MAX_CHAT_OUTPUT_JSON_TEMPLATE_CHARS).optional(),
});

const translateBodySchema = z.object({
  taskType: z.literal("translate"),
  sourceLang: z.string().trim().min(1, "sourceLang is required"),
  sourceCode: z.string().trim().min(2, "sourceCode is required").max(12),
  targetLang: z.string().trim().min(1, "targetLang is required"),
  targetCode: z.string().trim().min(2, "targetCode is required").max(12),
  text: z.string().trim().min(1, "text is required"),
  maxTokens: z.number().int().min(1).max(MAX_CHAT_MAX_TOKENS).optional(),
});

export const chatJobCreateBodySchema = z.discriminatedUnion("taskType", [
  chatBodySchema,
  ragBodySchema,
  translateBodySchema,
]);

export type ChatJobCreateBodyParsed = z.infer<typeof chatJobCreateBodySchema>;

export type NormalizedChatJobCreateBody = {
  taskType: string;
  model: string;
  input: { role: "system" | "user" | "assistant" | "tool"; content: string }[];
  maxTokens?: number;
};

/** @deprecated Use NormalizedChatJobCreateBody after normalizeChatJobCreateBody */
export type ChatJobCreateBody = NormalizedChatJobCreateBody;

export async function normalizeChatJobCreateBody(
  parsed: ChatJobCreateBodyParsed,
  userId: string,
): Promise<NormalizedChatJobCreateBody> {
  if (parsed.taskType === "translate") {
    await assertTranslateTextWithinPlanLimits(userId, parsed.text);
    return {
      taskType: "translate",
      model: TRANSLATE_JOB_MODEL_LABEL,
      input: [
        {
          role: "user",
          content: buildTranslatePrompt({
            sourceLang: parsed.sourceLang,
            sourceCode: parsed.sourceCode,
            targetLang: parsed.targetLang,
            targetCode: parsed.targetCode,
            text: parsed.text,
          }),
        },
      ],
      maxTokens: parsed.maxTokens,
    };
  }

  return {
    taskType: parsed.taskType,
    model: parsed.model,
    input: parsed.input,
    maxTokens: parsed.maxTokens,
  };
}
