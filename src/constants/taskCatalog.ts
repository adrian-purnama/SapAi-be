type ModelDef = {
  provider: "ollama";
  id: string;
  env?: string;
};

export const MODELS = {
  OCT3Q: { provider: "ollama", id: "gemma4:12b" },
  TRANSLATE: { provider: "ollama", id: "translategemma", env: "OLLAMA_TRANSLATE_MODEL" },
  ocr: { provider: "ollama", id: "glm-ocr:bf16" },
  EMBED: { provider: "ollama", id: "nomic-embed-text" },
} as const satisfies Record<string, ModelDef>;

export type ModelLabel = keyof typeof MODELS;

export const TASKS = {
  chat: { models: ["OCT3Q"] },
  rag: { models: ["OCT3Q"] },
  translate: { models: ["TRANSLATE"] },
  ocr: { models: ["ocr"] },
} as const satisfies Record<string, { models: readonly ModelLabel[] }>;

export const INFRA = { embed: "EMBED" } as const satisfies { embed: ModelLabel };

export const CHAT_TASK_TYPES = Object.keys(TASKS) as (keyof typeof TASKS)[];

export type ChatTaskType = keyof typeof TASKS;

export const DEFAULT_TASK_ACCESS: Record<string, string[]> = Object.fromEntries(
  CHAT_TASK_TYPES.map((taskType) => [taskType, modelLabelsForTask(taskType)]),
);

export const TRANSLATE_JOB_MODEL_LABEL = TASKS.translate.models[0]!;
export const OCR_JOB_MODEL_LABEL = TASKS.ocr.models[0]!;
export const OCR_SYSTEM_PROMPT =
  "Use the task tabs above to run Text Recognition, Formula Recognition, or Table Recognition on the uploaded image.";

export function isChatTaskType(value: string): value is ChatTaskType {
  return value in TASKS;
}

export function modelLabelsForTask(taskType: string): string[] {
  const entry = TASKS[taskType as ChatTaskType];
  if (!entry) return [];
  return [...entry.models];
}

export function resolveModelId(label: string): string {
  const model = MODELS[label as ModelLabel];
  if (!model) {
    throw new Error(`Unknown model label: ${label}`);
  }
  if ("env" in model && model.env) {
    return process.env[model.env]?.trim() || model.id;
  }
  return model.id;
}

export function resolveBackendModel(taskType: string, label: string): string {
  const entry = TASKS[taskType as ChatTaskType];
  if (!entry) {
    throw new Error(`Unknown task type: ${taskType}`);
  }
  if (!(entry.models as readonly string[]).includes(label)) {
    throw new Error(`Unknown model label "${label}" for task type "${taskType}"`);
  }
  return resolveModelId(label);
}

export function resolveEmbedBackendModel(): string {
  return resolveModelId(INFRA.embed);
}

/** Public catalog view (labels only, no backend ids). */
export function getPublicTaskCatalog(): {
  taskType: string;
  provider: string;
  availableModels: string[];
}[] {
  return CHAT_TASK_TYPES.map((taskType) => ({
    taskType,
    provider: MODELS[TASKS[taskType].models[0]!]!.provider,
    availableModels: modelLabelsForTask(taskType),
  }));
}

// ponytail: self-check   fails fast if MODELS/TASKS drift
if (resolveBackendModel("chat", "OCT3Q") !== MODELS.OCT3Q.id) {
  throw new Error("taskCatalog self-check failed");
}
if (resolveBackendModel("ocr", "ocr") !== MODELS.ocr.id) {
  throw new Error("taskCatalog ocr self-check failed");
}
