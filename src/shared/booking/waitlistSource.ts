/**
 * Public web submissions use the same-origin capacity-rescue route. The legacy
 * `create_public_waitlist_entry` RPC remains service-role-only for Voice AI.
 *
 * - `slot_unavailable`: UI computed zero slots for that service/day/staff (step Time).
 * - `booking_conflict`: server-side insert failed due to overlap/race after confirm (RPC/table constraint).
 */
export type BookingWaitlistSource =
  | "slot_unavailable"
  | "booking_conflict";
