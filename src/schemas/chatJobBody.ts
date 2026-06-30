import { z } from "zod";

import {
  MAX_CHAT_INPUT_MESSAGES,
  MAX_CHAT_MAX_TOKENS,
  MAX_CHAT_OUTPUT_JSON_TEMPLATE_CHARS,
} from "../constants/chatLimits.js";
import {
  CHAT_TASK_TYPES,
  modelLabelsForTask,
  OCR_JOB_MODEL_LABEL,
  OCR_SYSTEM_PROMPT,
  TRANSLATE_JOB_MODEL_LABEL,
} from "../constants/taskCatalog.js";
import { buildTranslatePrompt } from "../utils/buildTranslatePrompt.js";
import {
  assertOcrImageWithinPlanLimits,
  assertTranslateTextWithinPlanLimits,
} from "../utils/planChatLimits.js";

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

const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;

const chatSessionFields = {
  sessionId: z.string().trim().min(1).optional(),
  generateSessionId: z.boolean().optional(),
};

function refineChatSessionFields(
  val: { sessionId?: string; generateSessionId?: boolean },
  ctx: z.RefinementCtx,
): void {
  if (val.sessionId && val.generateSessionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Use sessionId or generateSessionId, not both.",
      path: ["sessionId"],
    });
  }
  if (val.sessionId && !OBJECT_ID_RE.test(val.sessionId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sessionId must be a valid MongoDB ObjectId.",
      path: ["sessionId"],
    });
  }
}

const chatBodySchema = z
  .object({
    taskType: z.literal("chat"),
    model: chatModelEnum,
    input: z
      .array(chatMessageSchema)
      .min(1, "At least one message is required")
      .max(MAX_CHAT_INPUT_MESSAGES),
    maxTokens: z.number().int().min(1).max(MAX_CHAT_MAX_TOKENS).optional(),
    outputJsonTemplate: z.string().max(MAX_CHAT_OUTPUT_JSON_TEMPLATE_CHARS).optional(),
    ...chatSessionFields,
  })
  .superRefine(refineChatSessionFields);

const ragBodySchema = z
  .object({
    taskType: z.literal("rag"),
    model: ragModelEnum,
    input: z
      .array(chatMessageSchema)
      .min(1, "At least one message is required")
      .max(MAX_CHAT_INPUT_MESSAGES),
    maxTokens: z.number().int().min(1).max(MAX_CHAT_MAX_TOKENS).optional(),
    outputJsonTemplate: z.string().max(MAX_CHAT_OUTPUT_JSON_TEMPLATE_CHARS).optional(),
    ...chatSessionFields,
  })
  .superRefine(refineChatSessionFields);

const translateBodySchema = z
  .object({
    taskType: z.literal("translate"),
    sourceLang: z.string().trim().min(1, "sourceLang is required"),
    sourceCode: z.string().trim().min(2, "sourceCode is required").max(12),
    targetLang: z.string().trim().min(1, "targetLang is required"),
    targetCode: z.string().trim().min(2, "targetCode is required").max(12),
    text: z.string().trim().min(1, "text is required"),
    maxTokens: z.number().int().min(1).max(MAX_CHAT_MAX_TOKENS).optional(),
    ...chatSessionFields,
  })
  .superRefine(refineChatSessionFields);

const ocrBodySchema = z
  .object({
    taskType: z.literal("ocr"),
    imageBase64: z.string().min(1, "imageBase64 is required"),
    mode: z.enum(["text", "formula", "table"]).optional().default("text"),
    maxTokens: z.number().int().min(1).max(MAX_CHAT_MAX_TOKENS).optional(),
    ...chatSessionFields,
  })
  .superRefine(refineChatSessionFields);

export const chatJobCreateBodySchema = z.discriminatedUnion("taskType", [
  chatBodySchema,
  ragBodySchema,
  translateBodySchema,
  ocrBodySchema,
]);

export type ChatJobCreateBodyParsed = z.infer<typeof chatJobCreateBodySchema>;

export type NormalizedChatJobCreateBody = {
  taskType: string;
  model: string;
  input: {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    images?: string[];
  }[];
  maxTokens?: number;
};

/** @deprecated Use NormalizedChatJobCreateBody after normalizeChatJobCreateBody */
export type ChatJobCreateBody = NormalizedChatJobCreateBody;

const OCR_MODE_LABELS: Record<"text" | "formula" | "table", string> = {
  text: "Text Recognition",
  formula: "Formula Recognition",
  table: "Table Recognition",
};

/** Strip `data:image/...;base64,` prefix; Ollama expects raw base64. */
export function stripDataUrlBase64(value: string): string {
  return value.replace(/^data:image\/[^;]+;base64,/, "").trim();
}

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

  if (parsed.taskType === "ocr") {
    const imageBase64 = stripDataUrlBase64(parsed.imageBase64);
    await assertOcrImageWithinPlanLimits(userId, imageBase64);
    return {
      taskType: "ocr",
      model: OCR_JOB_MODEL_LABEL,
      input: [
        { role: "system", content: OCR_SYSTEM_PROMPT },
        {
          role: "user",
          content: OCR_MODE_LABELS[parsed.mode],
          images: [imageBase64],
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
