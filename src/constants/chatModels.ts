/** Allowed LLM ids for chat jobs (parity with former FastAPI `ALLOWED_CHAT_MODEL_IDS`). */
export const ALLOWED_CHAT_MODEL_IDS = [
    {
        label: "OCT3Q",
        model: "gemma4:e4b",
    },
] as const;
