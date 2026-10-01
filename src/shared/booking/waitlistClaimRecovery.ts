import {
  existingBookingManagementRequestId,
  stableBookingManagementRequestId,
} from "./bookingManagementRequestId";

/** Never mint a new intent for a consumed/unavailable offer during recovery. */
export async function waitlistClaimRequestId(
  token: string,
  isAvailable: boolean,
): Promise<string | null> {
  const intent = { action: "waitlist_claim" as const, token };
  const existing = await existingBookingManagementRequestId(intent);
  if (existing) return existing;
  return isAvailable ? stableBookingManagementRequestId(intent) : null;
}
