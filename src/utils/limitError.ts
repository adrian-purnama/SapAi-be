export class LimitError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "LimitError";
    this.code = code;
  }
}

export function limitErrorHttpStatus(code: string): number {
  if (code === "TASK_NOT_ALLOWED" || code === "MODEL_NOT_ALLOWED") return 403;
  return 400;
}
