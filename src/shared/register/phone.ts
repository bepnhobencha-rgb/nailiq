/** ITU-T E.164 uses at most 15 digits total (international format). */
export const REGISTER_PHONE_MIN_DIGITS = 8;
export const REGISTER_PHONE_MAX_DIGITS = 15;

/**
 * Canonical digit string for registration, `salons.phone`, OTP keys, tokens.
 *
 * - Strips non-digits.
 * - NANP numbers (often entered as 10 digits without leading country code): prepend `1`
 *   when the stripped string matches NXX‑NXX‑XXXX (first digit `2–9`).
 * - Otherwise unchanged (supports country codes such as Vietnam `849…`).
 *
 * Matches Supabase Phone auth / Twilio semantics for `user.phone` (~E.164 without `+`).
 */
export function normalizeRegisterPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10 && /^[2-9]\d{9}$/.test(d)) {
    return `1${d}`;
  }
  return d;
}

/** Same rule everywhere so client and server never disagree. */
export function isRegisterPhoneDigitsValid(digits: string): boolean {
  const n = digits.length;
  return n >= REGISTER_PHONE_MIN_DIGITS && n <= REGISTER_PHONE_MAX_DIGITS;
}

/**
 * Builds E.164 with leading + for Supabase phone auth.
 * Heuristic: leading 0 (e.g. VN local) → strip 0 and prefix 84 if looks local.
 */
export function digitsToE164Phone(digits: string): string | null {
  const d = normalizeRegisterPhone(digits);
  if (!isRegisterPhoneDigitsValid(d)) return null;

  let e164: string;
  if (d.startsWith("0") && d.length >= 9) {
    e164 = `+84${d.slice(1)}`;
  } else {
    e164 = `+${d}`;
  }

  if (!e164.startsWith("+")) {
    e164 = `+${e164.replace(/\D/g, "")}`;
  }
  return e164;
}

/**
 * Canonical E.164 with leading "+" for Supabase Auth and Twilio Verify
 * (`createUser`, `signInWithPassword`, Verification API).
 * Handles register-normalized digits, values missing "+", or already "+…" strings.
 */
export function ensureSupabaseAuthE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith("+")) {
    return digitsToE164Phone(trimmed);
  }

  const plusBody = trimmed.slice(1).replace(/\D/g, "");
  if (!isRegisterPhoneDigitsValid(plusBody)) return null;

  if (plusBody.startsWith("0") && plusBody.length >= 9) {
    return `+84${plusBody.slice(1)}`;
  }

  return `+${plusBody}`;
}
