/**
 * Strip everything except digits and leading +.
 * "604-555-0142" → "6045550142"
 * "+1 (604) 555-0142" → "+16045550142"
 */
export function cleanPhone(raw: string): string {
  const s = raw.trim();
  if (s.startsWith("+")) {
    return `+${s.slice(1).replace(/\D/g, "")}`;
  }
  return s.replace(/\D/g, "");
}

/**
 * Format US/CA 10-digit phone for display.
 * "6045550142" → "(604) 555-0142"
 * "16045550142" → "+1 (604) 555-0142"
 * Anything else → return as-is
 */
export function formatPhone(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  const cleaned = cleanPhone(raw);
  const digitsOnly = cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;

  if (digitsOnly.length === 10) {
    const a = digitsOnly.slice(0, 3);
    const b = digitsOnly.slice(3, 6);
    const c = digitsOnly.slice(6, 10);
    return `(${a}) ${b}-${c}`;
  }

  if (digitsOnly.length === 11 && digitsOnly.startsWith("1")) {
    const rest = digitsOnly.slice(1);
    const a = rest.slice(0, 3);
    const b = rest.slice(3, 6);
    const c = rest.slice(6, 10);
    return `+1 (${a}) ${b}-${c}`;
  }

  return raw.trim();
}

/** Digits-only body used for validation / storage parity with `cleanPhone`. */
export function normalizedPhoneDigits(input: string): string {
  const c = cleanPhone(input.trim());
  return c.startsWith("+") ? c.slice(1) : c;
}

const E164_MIN_DIGITS = 10;
const E164_MAX_DIGITS = 15;

/**
 * Loose E.164-style check: normalized digit count after `cleanPhone` (10–15).
 * Accepts local or +country prefixes; trims formatting characters.
 */
export function isValidPhoneE164(input: string): boolean {
  const digits = normalizedPhoneDigits(input);
  return (
    digits.length >= E164_MIN_DIGITS &&
    digits.length <= E164_MAX_DIGITS &&
    /^\d+$/.test(digits)
  );
}
