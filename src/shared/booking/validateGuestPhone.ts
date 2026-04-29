/**
 * Flowchart / E.164-oriented guest phone: 8–15 digits after stripping separators.
 */
export const GUEST_PHONE_DIGITS_MIN = 8;
export const GUEST_PHONE_DIGITS_MAX = 15;

export function digitsOnlyPhone(input: string): string {
  return input.replace(/\D/g, "");
}

export type GuestPhoneValidation =
  | { ok: true; digits: string }
  | { ok: false };

/** Accepts local dialing habits; stores digits only for consistency with existing rows. */
export function validateGuestPhone(input: string): GuestPhoneValidation {
  const digits = digitsOnlyPhone(input.trim());
  if (
    digits.length < GUEST_PHONE_DIGITS_MIN ||
    digits.length > GUEST_PHONE_DIGITS_MAX
  ) {
    return { ok: false };
  }
  return { ok: true, digits };
}
