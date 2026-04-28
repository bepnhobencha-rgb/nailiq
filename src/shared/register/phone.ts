/** ITU-T E.164 uses at most 15 digits total (international format). */
export const REGISTER_PHONE_MIN_DIGITS = 8;
export const REGISTER_PHONE_MAX_DIGITS = 15;

/** Digits-only phone for registration OTP (client + server). */
export function normalizeRegisterPhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** Same rule everywhere so client and server never disagree. */
export function isRegisterPhoneDigitsValid(digits: string): boolean {
  const n = digits.length;
  return (
    n >= REGISTER_PHONE_MIN_DIGITS && n <= REGISTER_PHONE_MAX_DIGITS
  );
}
