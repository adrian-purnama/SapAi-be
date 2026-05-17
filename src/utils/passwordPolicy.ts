export const PASSWORD_MIN_LENGTH = 8;

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

