import { canonicalizeStrictRfc3339Instant } from "@/shared/lib/strictRfc3339Instant";

/**
 * Wix booking events must carry a complete, positive provider-owned window.
 * Never invent a default duration: doing so creates a calendar block that Wix
 * did not authorize and can hide a real overlap.
 */
export function parseWixBookingWindow(input: {
  startDate?: unknown;
  slotStartDate?: unknown;
  endDate?: unknown;
  slotEndDate?: unknown;
}): { startUtc: string; endUtc: string; durationMinutes: number } | null {
  const startUtc = canonicalizeStrictRfc3339Instant(
    input.startDate ?? input.slotStartDate,
  );
  const endUtc = canonicalizeStrictRfc3339Instant(
    input.endDate ?? input.slotEndDate,
  );
  if (!startUtc || !endUtc) return null;

  const durationMilliseconds = Date.parse(endUtc) - Date.parse(startUtc);
  if (durationMilliseconds <= 0 || durationMilliseconds % 60_000 !== 0) {
    return null;
  }
  const durationMinutes = durationMilliseconds / 60_000;
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes > 24 * 60) {
    return null;
  }
  return { startUtc, endUtc, durationMinutes };
}
