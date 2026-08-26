import {
  mintBookingManagementCapability,
  type IndividualBookingManagementAction,
} from "@/shared/booking/bookingManagementCapabilities";

/** Safe fallback only. Callers rendering appointment-long links must pass the
 * exact required expiry; the DB enforces each action's appointment/server cap. */
const FALLBACK_TTL_MS = 4 * 60 * 1000;

/** Link capabilities are intentionally independent; confirming cannot consume
 * reschedule, cancel, status or card-management authority. */
export const REMINDER_MANAGEMENT_ACTIONS = [
  "confirm",
  "reschedule",
  "cancel",
  "status",
  "card_manage",
] as const satisfies readonly IndividualBookingManagementAction[];

export type ReminderToken = {
  id: string;
  expiresAt: string;
  action: IndividualBookingManagementAction;
};

/**
 * Creates (or reuses) an action-scoped management capability for a booking.
 * Returns null if the booking isn't found or DB write fails.
 *
 * `opts.expiresAt` overrides the default 48h TTL — used by the booking
 * confirmation email, which is sent at booking time (potentially days before
 * the appointment) and needs the self-serve reschedule/cancel link to stay
 * valid right up to the appointment, not expire 48h after booking.
 */
export async function generateReminderToken(
  bookingId: string,
  salonId: string,
  opts: { action: IndividualBookingManagementAction; expiresAt?: string },
): Promise<ReminderToken | null> {
  const expiresAt =
    opts.expiresAt ?? new Date(Date.now() + FALLBACK_TTL_MS).toISOString();
  const minted = await mintBookingManagementCapability({
    bookingId,
    salonId,
    action: opts.action,
    minExpiresAt: expiresAt,
  });
  if (!minted.ok) return null;
  return {
    id: minted.capability.tokenId,
    expiresAt: minted.capability.expiresAt,
    action: minted.capability.action,
  };
}
