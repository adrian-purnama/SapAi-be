import crypto from "node:crypto";

export const OTP_DIGIT_RE = /^\d{6}$/;

export function generateOtp(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function isValidOtpFormat(otp: string): boolean {
  return OTP_DIGIT_RE.test(otp);
}

/** Constant-time compare for two sha256 hex digests. */
export function safeHashEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return ba.length === bb.length && ba.length === 32 && crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
