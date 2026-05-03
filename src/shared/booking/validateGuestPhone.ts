import {
  isValidPhoneE164,
  normalizedPhoneDigits,
} from "@/shared/lib/phoneFormat";

/** Match E.164 national significant number length (digits only after normalization). */
export const GUEST_PHONE_DIGITS_MIN = 10;
export const GUEST_PHONE_DIGITS_MAX = 15;

/** @deprecated Prefer `normalizedPhoneDigits` / `cleanPhone`; kept for call sites importing the name. */
export function digitsOnlyPhone(input: string): string {
  return normalizedPhoneDigits(input);
}

export type GuestPhoneValidation =
  | { ok: true; digits: string }
  | { ok: false };

/** Accepts formatted input; persists digits-only (no "+") aligned with `create_public_booking`. */
export function validateGuestPhone(input: string): GuestPhoneValidation {
  if (!isValidPhoneE164(input)) {
    return { ok: false };
  }
  return { ok: true, digits: normalizedPhoneDigits(input) };
}
