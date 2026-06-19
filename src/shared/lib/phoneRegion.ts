// Region detection for outbound-channel gating (A2P 10DLC). Uses the same
// /core + explicit metadata import pattern as validateGuestPhone.ts to stay
// compatible with the tsx test runner and the Next.js bundler.
import _parseCore from "libphonenumber-js/core";
import _metadata from "libphonenumber-js/metadata.min.json";

/**
 * ISO 3166-1 country of a phone number (e.g. "US", "CA", "VN"), or null when
 * unparseable. Bare NANP locals default to CA (matches validateGuestPhone).
 */
export function phoneRegion(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = _parseCore(trimmed, "CA", _metadata as any);
  return parsed?.country ?? null;
}

/**
 * True only when the destination is a US number. US destinations require Twilio
 * A2P 10DLC registration; unregistered US SMS is silently carrier-dropped (and
 * can still incur Twilio fees), so callers route these to email instead.
 * Canadian / international +1 and all other regions are unaffected.
 */
export function isUsPhone(raw: string | null | undefined): boolean {
  return phoneRegion(raw) === "US";
}
