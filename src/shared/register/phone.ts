/** Digits-only phone for registration OTP (client + server). */
export function normalizeRegisterPhone(raw: string): string {
  return raw.replace(/\D/g, "");
}
