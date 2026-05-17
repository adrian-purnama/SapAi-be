import type { OtpPurpose } from "../models/OtpCode.js";
import { OtpCodeModel } from "../models/OtpCode.js";
import { generateOtp, isValidOtpFormat, safeHashEqualHex } from "../auth/otpUtils.js";
import { sha256Hex } from "../utils/sha256.js";

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES ?? 10);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS ?? 5);
const OTP_RESEND_COOLDOWN_SEC = Number(process.env.OTP_RESEND_COOLDOWN_SEC ?? 60);

export { OTP_MAX_ATTEMPTS };

export function readOtpResendCooldownMs(): number {
  const sec = Number.isFinite(OTP_RESEND_COOLDOWN_SEC) && OTP_RESEND_COOLDOWN_SEC >= 0
    ? OTP_RESEND_COOLDOWN_SEC
    : 60;
  return sec * 1000;
}

export type UpsertOtpResult =
  | { ok: true; otp: string; expiresAt: Date }
  | { ok: false; code: "RESEND_COOLDOWN"; retryAfterSec: number };

/** Create or replace OTP; enforces resend cooldown without resetting attempt budget early. */
export async function upsertOtpForEmail(
  email: string,
  purpose: OtpPurpose,
): Promise<UpsertOtpResult> {
  const now = Date.now();
  const existing = await OtpCodeModel.findOne({ email, purpose }).lean();
  if (existing?.lastSentAt) {
    const elapsed = now - new Date(existing.lastSentAt).getTime();
    const cooldownMs = readOtpResendCooldownMs();
    if (elapsed < cooldownMs) {
      return {
        ok: false,
        code: "RESEND_COOLDOWN",
        retryAfterSec: Math.ceil((cooldownMs - elapsed) / 1000),
      };
    }
  }

  const otp = generateOtp();
  const codeHash = sha256Hex(otp);
  const expiresAt = new Date(now + OTP_TTL_MINUTES * 60 * 1000);
  const lastSentAt = new Date(now);

  await OtpCodeModel.findOneAndUpdate(
    { email, purpose },
    {
      email,
      purpose,
      codeHash,
      expiresAt,
      lastSentAt,
      // Fresh code invalidates prior guesses.
      attempts: 0,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return { ok: true, otp, expiresAt };
}

export type VerifyOtpResult =
  | { ok: true; otpDocId: import("mongoose").Types.ObjectId }
  | { ok: false; status: number; code: string; message: string };

export async function verifyOtpForEmail(
  email: string,
  purpose: OtpPurpose,
  otp: string,
): Promise<VerifyOtpResult> {
  if (!isValidOtpFormat(otp)) {
    return { ok: false, status: 400, code: "INVALID_OTP", message: "OTP must be 6 digits." };
  }

  const otpDoc = await OtpCodeModel.findOne({ email, purpose });
  if (!otpDoc) {
    return {
      ok: false,
      status: 400,
      code: "OTP_NOT_FOUND",
      message: "OTP not found. Request a new OTP.",
    };
  }
  if (otpDoc.expiresAt.getTime() < Date.now()) {
    await OtpCodeModel.deleteOne({ _id: otpDoc._id });
    return {
      ok: false,
      status: 400,
      code: "OTP_EXPIRED",
      message: "OTP expired. Request a new OTP.",
    };
  }
  if ((otpDoc.attempts ?? 0) >= OTP_MAX_ATTEMPTS) {
    return {
      ok: false,
      status: 429,
      code: "OTP_ATTEMPTS_EXCEEDED",
      message: "OTP attempts exceeded. Request a new OTP.",
    };
  }

  const providedHash = sha256Hex(otp);
  if (!safeHashEqualHex(otpDoc.codeHash, providedHash)) {
    otpDoc.attempts = (otpDoc.attempts ?? 0) + 1;
    await otpDoc.save();
    return { ok: false, status: 400, code: "OTP_INCORRECT", message: "Incorrect OTP." };
  }

  return { ok: true, otpDocId: otpDoc._id };
}
