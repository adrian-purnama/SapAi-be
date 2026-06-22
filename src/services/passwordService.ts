import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import bcrypt from "bcryptjs";

const scryptAsync = promisify(scrypt);
const SCRYPT_PREFIX = "scrypt:";
const SCRYPT_KEYLEN = 64;

export type PasswordVerifyResult =
  | { ok: true; needsUpgrade: false }
  | { ok: true; needsUpgrade: true }
  | { ok: false };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return `${SCRYPT_PREFIX}${salt.toString("base64")}:${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, passwordHash: string): Promise<PasswordVerifyResult> {
  if (passwordHash.startsWith(SCRYPT_PREFIX)) {
    const body = passwordHash.slice(SCRYPT_PREFIX.length);
    const sep = body.indexOf(":");
    if (sep < 0) return { ok: false };
    const salt = Buffer.from(body.slice(0, sep), "base64");
    const expected = Buffer.from(body.slice(sep + 1), "base64");
    const derived = (await scryptAsync(password, salt, expected.length)) as Buffer;
    if (derived.length !== expected.length || !timingSafeEqual(derived, expected)) {
      return { ok: false };
    }
    return { ok: true, needsUpgrade: false };
  }

  if (passwordHash.startsWith("$2")) {
    const ok = await bcrypt.compare(password, passwordHash);
    return ok ? { ok: true, needsUpgrade: true } : { ok: false };
  }

  return { ok: false };
}
