import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";

/**
 * THE single canonical phone normalizer. Every code path that PERSISTS a
 * customer phone (booking form, group, voice AI, party claim, walk-in,
 * Wix import, gift card, quick-rebook, …) must run the value through this
 * so the database holds ONE format: E.164 digits WITHOUT a leading "+",
 * with a country code — e.g. "17788680738".
 *
 * Primary path uses libphonenumber via `validateGuestPhone` (handles
 * international numbers correctly). For inputs it can't fully parse we
 * fall back to a conservative NANP-style normalization so we still store
 * a consistent format instead of raw/"+"/10-digit junk.
 *
 * A matching `canonical_phone()` SQL function + BEFORE INSERT/UPDATE
 * triggers enforce the same shape at the database boundary, so even an
 * un-migrated or future code path can't reintroduce a bad format.
 *
 * Returns null when the input has too few digits to be a real phone.
 */
export function toCanonicalPhone(
  raw: string | null | undefined,
): string | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;

  const parsed = validateGuestPhone(input);
  if (parsed.ok) return parsed.digits;

  // Fallback: strip to digits, add NANP country code to bare 10-digit.
  const digits = input.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.length === 10 ? `1${digits}` : digits;
}
