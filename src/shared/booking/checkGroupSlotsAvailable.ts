"use server";

/**
 * Pre-submit availability probe for the group-booking confirm step.
 *
 * Task #04-C FIX 01. The user picked an arrangement on step 4 and
 * has been sitting on step 5 entering contact details. During that
 * dwell, another customer (individual or group) may have booked one
 * of the slots in the user's selected arrangement. The `bookings_no_overlap`
 * GIST EXCLUDE catches this at insert time inside `insert_group_bookings`,
 * but the resulting UX is "click Confirm → wait → slot_conflict
 * error → re-pick everything".
 *
 * This action calls `check_group_slots_available` (migration
 * 20260512700000) right when step 5 mounts. If any slot is gone,
 * the client triggers a silent re-run of the scheduler and surfaces
 * a small "a slot was just taken — finding new options" banner —
 * no error, no friction.
 *
 * The RPC uses the SAME overlap predicate (half-open
 * `start < end AND end > start`) as the GIST constraint, so a
 * pre-check pass is a strong promise that the insert won't race
 * (assuming no concurrent booking in the few ms between this
 * probe and the submit click).
 */

import { createClient } from "@/shared/lib/supabase/server";

export type GroupSlotProbe = {
  /** 0-indexed position in the arrangement's member list. Echoed
   *  back in `conflictingMembers` so the UI can highlight which
   *  member's slot was lost. */
  memberIndex: number;
  salonId: string;
  staffId: string;
  startUtcIso: string;
  endUtcIso: string;
};

export type CheckGroupSlotsAvailableResult =
  | { available: true }
  | {
      available: false;
      /** 0-indexed member positions whose slots collided. May be
       *  empty if the RPC errored shape-wise — caller should treat
       *  empty-but-unavailable as "re-run scheduler" anyway. */
      conflictingMembers: number[];
    }
  | { available: false; error: "server_error" };

export async function checkGroupSlotsAvailable(
  slots: ReadonlyArray<GroupSlotProbe>,
): Promise<CheckGroupSlotsAvailableResult> {
  if (slots.length === 0) {
    return { available: true };
  }

  const supabase = await createClient();
  const payload = slots.map((s) => ({
    member_index: s.memberIndex,
    salon_id: s.salonId,
    staff_id: s.staffId,
    start_time_utc: s.startUtcIso,
    end_time_utc: s.endUtcIso,
  }));

  const { data, error } = await supabase.rpc("check_group_slots_available", {
    p_slots: payload,
  });
  if (error) {
    console.error("[checkGroupSlotsAvailable]", error);
    return { available: false, error: "server_error" };
  }

  const row = data as
    | { available: true }
    | { available: false; conflicting_members?: number[] }
    | null;

  if (!row || typeof row !== "object") {
    return { available: false, error: "server_error" };
  }
  if (row.available === true) return { available: true };

  const conflicting = Array.isArray(
    (row as { conflicting_members?: unknown }).conflicting_members,
  )
    ? ((row as { conflicting_members: unknown[] }).conflicting_members
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
        .map((n) => Math.trunc(n)))
    : [];
  return { available: false, conflictingMembers: conflicting };
}
