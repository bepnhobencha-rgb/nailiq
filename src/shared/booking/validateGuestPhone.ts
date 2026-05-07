import parsePhoneNumberFromString from "libphonenumber-js";
import { normalizedPhoneDigits } from "@/shared/lib/phoneFormat";

/** Default region for ambiguous local input (e.g. "6041234567" → +16041234567). CA-first market, expanding to US. */
const DEFAULT_COUNTRY = "CA" as const;

/** @deprecated Prefer `normalizedPhoneDigits` / `cleanPhone`; kept for call sites importing the name. */
export function digitsOnlyPhone(input: string): string {
  return normalizedPhoneDigits(input);
}

export type GuestPhoneValidation =
  | { ok: true; digits: string }
  | { ok: false };

/**
 * Country-aware parse + validate via libphonenumber-js.
 * Default region **CA** (NANP): bare 10-digit local numbers resolve as Canada/US +1;
 * explicit `+84…` and other international forms still validate.
 * Accepts:
 *   "6041234567"        → +16041234567   → digits "16041234567"
 *   "+1 778 868 0738"   → +17788680738   → digits "17788680738"
 *   "+84 90 123 4567"   → +84901234567   → digits "84901234567"
 * Persists digits-only (no leading "+") to match the `create_public_booking` RPC contract.
 */
export function validateGuestPhone(input: string): GuestPhoneValidation {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false };
  const parsed = parsePhoneNumberFromString(trimmed, DEFAULT_COUNTRY);
  if (!parsed || !parsed.isValid()) {
    return { ok: false };
  }
  return { ok: true, digits: parsed.number.slice(1) };
}
