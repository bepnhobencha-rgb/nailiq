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

/**
 * NANP-focused UI placeholder example (Canadian area code).
 * Used on owner auth and booking/contact fields; persisted values stay E.164.
 */
export const PHONE_INPUT_PLACEHOLDER_NANP = "+1 (604) 555-1234";

/**
 * P2.6 — Live-format-as-you-type helper for phone inputs.
 *
 * Differs from `formatPhone` in three ways:
 *   1. Returns the partial format string for any digit count (1 digit
 *      shows "(6"), so the input never "reverts" while the user types.
 *   2. Preserves a leading `+` so international callers (+84, +33) can
 *      still type their own format.
 *   3. Never re-arranges or drops characters — what's stored matches
 *      what's rendered character-for-character.
 *
 * Storage path is unchanged: `cleanPhone` / `normalizedPhoneDigits`
 * still strip formatting before validation + DB write, so this is
 * purely a presentation layer.
 */
export function formatPhoneInputProgressive(raw: string): string {
  const s = raw ?? "";
  if (s.trim().length === 0) return "";

  // International (`+...`) phones — keep the country prefix
  // visible while progressively formatting NANP (+1) numbers the
  // same way we format locals. P2.1: previously a "+1 6045551234"
  // entry collapsed to "+16045551234" with no spacing; now it
  // renders as "+1 (604) 555-1234" so the country code stays
  // legible.
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/\D/g, "");
    // NANP starts with country code 1; format the 10-digit tail
    // exactly like the local path.
    if (digits.startsWith("1")) {
      const rest = digits.slice(1);
      if (rest.length === 0) return "+1 ";
      if (rest.length < 4) return `+1 ${rest}`;
      if (rest.length < 7) return `+1 (${rest.slice(0, 3)}) ${rest.slice(3)}`;
      if (rest.length <= 10)
        return `+1 (${rest.slice(0, 3)}) ${rest.slice(3, 6)}-${rest.slice(6, 10)}`;
      return `+1 (${rest.slice(0, 3)}) ${rest.slice(3, 6)}-${rest.slice(6, 10)}${rest.slice(10)}`;
    }
    // Other countries (+84, +33, …) — leave the user's input alone
    // except for non-digit cleanup. Trying to guess national
    // formats causes more confusion than it solves.
    return `+${digits}`;
  }

  // NANP local-format path. Once the user fills 10 digits we
  // promote to the explicit `+1 (AAA) BBB-CCCC` form so the
  // country prefix is visible — placeholder text already promised
  // `+1`, so previously dropping it on display confused users
  // ("did the +1 get saved?"). For partial entries we keep the
  // local-only format until 10 digits land.
  const d = s.replace(/\D/g, "");
  if (d.length === 0) return "";
  if (d.length < 4) return d;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  if (d.length === 10) {
    // QA re-test #9: promote 10-digit NANP to "+1 (AAA) BBB-CCCC"
    // so the prefix stays visible. Backend stores E.164 digits via
    // `validateGuestPhone`; the display change is cosmetic only.
    return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
  }
  if (d.length < 10) {
    // Still typing — keep the local-only form so the cursor
    // doesn't jump while the user mid-types.
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  // 11+ digits starting with 1 = unmarked NANP with country prefix.
  if (d.length === 11 && d.startsWith("1")) {
    const rest = d.slice(1);
    return `+1 (${rest.slice(0, 3)}) ${rest.slice(3, 6)}-${rest.slice(6, 10)}`;
  }
  // Past 11 digits, assume the user is typing a country code
  // without the `+`. Promote to a `+` prefix.
  return `+${d}`;
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
