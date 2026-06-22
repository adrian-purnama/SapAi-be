/**
 * Builds a single system message instructing the model to reply with JSON matching a client template.
 * Placeholders like `$color` are documentation   the model must substitute real values.
 */
export function buildStructuredOutputSystemPrompt(template: string): string {
  const trimmed = template.trim();
  return [
    "You must reply with exactly one JSON value and nothing else.",
    "Do not wrap the JSON in markdown code fences or add any text before or after it.",
    "Replace any placeholder tokens (for example names starting with $) in the shape below with real values in your output   do not echo placeholder names literally.",
    'If you cannot comply, reply with a minimal JSON object: {"error":"<reason>"}.',
    "",
    "Required shape (structure and key names; values are illustrative):",
    trimmed,
  ].join("\n");
}
