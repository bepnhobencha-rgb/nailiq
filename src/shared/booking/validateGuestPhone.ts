// Using the /core entry with an explicit `import` for metadata avoids a tsx
// test-runner incompatibility: tsx wraps CJS `require("*.json")` in
// `{ default: ... }`, which breaks libphonenumber-js/min's internal
// `require('../metadata.min.json')` call (metadata ends up undefined).
// ES-module `import` correctly unwraps the default export in all environments
// (tsx, Next.js bundler, Node.js native ESM).
// `parsePhoneNumberFromString` (the default export) returns undefined on bad
// input; `parsePhoneNumber` throws ParseError.  We want silent failure.
import _parseCore from "libphonenumber-js/core";
import _metadata from "libphonenumber-js/metadata.min.json";
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = _parseCore(trimmed, DEFAULT_COUNTRY, _metadata as any);
  if (!parsed || !parsed.isValid()) {
    return { ok: false };
  }
  return { ok: true, digits: parsed.number.slice(1) };
}
