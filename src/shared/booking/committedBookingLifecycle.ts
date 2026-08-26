export type CommittedBookingLifecycleError =
  | "booking_cancelled"
  | "booking_completed"
  | "booking_rescheduled"
  | "booking_not_confirmed";

/** Classify an idempotent replay against the booking's current lifecycle.
 * A replay may acknowledge only the exact still-confirmed appointment; it must
 * not resurrect or re-announce a row that was cancelled, completed, or moved. */
export function committedBookingLifecycleError(input: {
  status: string | null | undefined;
  persistedStartTimeUtc: string | null | undefined;
  requestedStartTimeUtc: string;
}): CommittedBookingLifecycleError | null {
  const status = String(input.status ?? "").trim().toLowerCase();
  if (status === "cancelled") return "booking_cancelled";
  if (status === "completed") return "booking_completed";
  if (status !== "confirmed") return "booking_not_confirmed";

  const persistedStart = Date.parse(String(input.persistedStartTimeUtc ?? ""));
  const requestedStart = Date.parse(input.requestedStartTimeUtc);
  if (
    !Number.isFinite(persistedStart) ||
    !Number.isFinite(requestedStart) ||
    persistedStart !== requestedStart
  ) {
    return "booking_rescheduled";
  }
  return null;
}
