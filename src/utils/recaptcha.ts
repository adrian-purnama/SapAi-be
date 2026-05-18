const VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
export const RECAPTCHA_EMBED_CHAT_ACTION = "embed_chat";

function stripQuotes(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function readRecaptchaSecretKey(): string | null {
  const raw = process.env.RECAPTCHA_SECRET_KEY?.trim();
  return raw ? stripQuotes(raw) : null;
}

export function isRecaptchaConfigured(): boolean {
  return Boolean(readRecaptchaSecretKey());
}

function readMinScore(): number {
  const raw = process.env.RECAPTCHA_MIN_SCORE?.trim();
  const n = raw ? Number.parseFloat(raw) : Number.NaN;
  if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  return 0.5;
}

type SiteVerifyResponse = {
  success?: boolean;
  score?: number;
  action?: string;
  "error-codes"?: string[];
};

export type RecaptchaVerifyResult =
  | { ok: true; score?: number }
  | { ok: false; message: string; code: "RECAPTCHA_REQUIRED" | "RECAPTCHA_FAILED" };

export async function verifyRecaptchaToken(
  token: string | undefined | null,
  options?: { remoteIp?: string; expectedAction?: string },
): Promise<RecaptchaVerifyResult> {
  const secret = readRecaptchaSecretKey();
  if (!secret) {
    return { ok: true };
  }

  const response = String(token ?? "").trim();
  if (!response) {
    return {
      ok: false,
      message: "reCAPTCHA verification is required.",
      code: "RECAPTCHA_REQUIRED",
    };
  }

  const params = new URLSearchParams({ secret, response });
  const remoteIp = options?.remoteIp?.trim();
  if (remoteIp) params.set("remoteip", remoteIp);

  let payload: SiteVerifyResponse;
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    payload = (await res.json()) as SiteVerifyResponse;
    if (!res.ok) {
      return {
        ok: false,
        message: "reCAPTCHA verification failed.",
        code: "RECAPTCHA_FAILED",
      };
    }
  } catch {
    return {
      ok: false,
      message: "reCAPTCHA verification is temporarily unavailable.",
      code: "RECAPTCHA_FAILED",
    };
  }

  if (!payload.success) {
    const codes = payload["error-codes"]?.join(", ") ?? "unknown";
    return {
      ok: false,
      message: `reCAPTCHA verification failed (${codes}).`,
      code: "RECAPTCHA_FAILED",
    };
  }

  const expectedAction = options?.expectedAction?.trim();
  if (expectedAction && payload.action && payload.action !== expectedAction) {
    return {
      ok: false,
      message: "reCAPTCHA action mismatch.",
      code: "RECAPTCHA_FAILED",
    };
  }

  if (typeof payload.score === "number") {
    const minScore = readMinScore();
    if (payload.score < minScore) {
      return {
        ok: false,
        message: "reCAPTCHA score too low.",
        code: "RECAPTCHA_FAILED",
      };
    }
  }

  return { ok: true, score: payload.score };
}
