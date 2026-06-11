/** Allowed LLM ids for chat jobs (parity with former FastAPI `ALLOWED_CHAT_MODEL_IDS`). */
export const ALLOWED_CHAT_MODEL_IDS = [
  {
    label: "OCT3Q",
    model: "gemma4:12b",
  },
] as const;

/** Stored on `ChatJob.model` for `taskType: translate` (resolved to Ollama id at runtime). */
export const TRANSLATE_JOB_MODEL_LABEL = "TRANSLATE";

export function readOllamaTranslateModel(): string {
  return process.env.OLLAMA_TRANSLATE_MODEL?.trim() || "translategemma";
}
