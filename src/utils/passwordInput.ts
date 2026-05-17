import { validateNewPassword } from "./passwordPolicy.js";

export const MAX_PASSWORD_CHARS = 128;

export function rejectPasswordIfTooLong(password: string): string | null {
  if (password.length > MAX_PASSWORD_CHARS) {
    return "Password is too long.";
  }
  return null;
}

/** Length check then policy rules. */
export function validatePasswordForAuth(password: string): string | null {
  const tooLong = rejectPasswordIfTooLong(password);
  if (tooLong) return tooLong;
  return validateNewPassword(password);
}
