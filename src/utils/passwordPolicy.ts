export const PASSWORD_MIN_LENGTH = 8;
export const MAX_PASSWORD_CHARS = 128;

export function validateNewPassword(password: string): string | null {
  const value = password ?? "";
  const ok =
    value.length >= PASSWORD_MIN_LENGTH &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /\d/.test(value) &&
    /[^A-Za-z0-9]/.test(value);
  return ok ? null : "Password does not meet the requirements.";
}

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
