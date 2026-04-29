/**
 * Both triggers write to `booking_waitlist_entries` via `create_public_waitlist_entry`.
 *
 * - `slot_unavailable`: UI computed zero slots for that service/day/staff (step Time).
 * - `booking_conflict`: server-side insert failed due to overlap/race after confirm (RPC/table constraint).
 */
export type BookingWaitlistSource = "slot_unavailable" | "booking_conflict";
