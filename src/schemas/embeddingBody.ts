import { z } from "zod";

const embedInputString = z.string().trim().min(1).max(8192);

/** Body for `POST /api/v1/embed` — proxied to Ollama `POST /api/embed`. */
export const embeddingBodySchema = z.object({
  /** When omitted, server uses `OLLAMA_EMBED_MODEL`. */
  model: z.string().trim().min(1).max(256).optional(),
  input: z.union([embedInputString, z.array(embedInputString).min(1).max(32)]),
});

export type EmbeddingBody = z.infer<typeof embeddingBodySchema>;
