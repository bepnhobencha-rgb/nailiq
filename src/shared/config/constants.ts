/**
 * Cross-cutting timing + sizing constants.
 *
 * Anything pulled out of code into here lives in ONE place so a PM
 * tuning request ("can we make the stale warning 5 min instead of
 * 3?") is a single-line change with predictable blast radius. The
 * rule of thumb: if a magic number is referenced in more than one
 * file, or if the value would plausibly need PM tuning post-launch,
 * it belongs here.
 *
 * Values denominated in `_MS` are milliseconds (suitable for
 * `setTimeout` / `Date.now()` math). `GROUP_MAX_SIZE` is a count.
 *
 * NOT in here:
 *   - Per-tenant config (use the DB row instead — e.g. salon
 *     opening hours, plan limits).
 *   - i18n copy (lives in `src/shared/i18n/`).
 *   - Per-render UI tokens (lives in Tailwind tokens / DESIGN_SYSTEM.md).
 */

/**
 * Group-booking — stale-arrangement banner threshold. Step 5
 * shows "this arrangement is N+ min old" when the user has been
 * sitting on the confirm screen longer than this. Picked at 3 min
 * because:
 *   - real-world double-booking races on the same slot are sparse
 *     (most tenants are <2 bookings/min per staff)
 *   - users complete step 5 in median ~30s; 3 min covers the
 *     long-tail without nagging the median
 */
export const GROUP_ARRANGEMENT_STALE_MS = 3 * 60 * 1000;

/**
 * Group-booking — session-idle warning on step 5. If the user
 * lands on the confirm screen and doesn't act for this long, a
 * non-blocking banner reminds them to confirm before the
 * arrangement holds expire. 25 min sits just under typical
 * Supabase auth refresh windows, so the user can still confirm
 * after acknowledging.
 */
export const SESSION_WARNING_MS = 25 * 60 * 1000;

/**
 * Receptionist walk-in — buffer window for "this staff has a
 * group booking soon" warning. Walk-in assignment dialog flags any
 * staff with a group booking starting within this window. 30 min
 * matches a typical service slot, so a walk-in won't be assigned
 * to someone about to start a group session.
 *
 * Used by future fix (Task #04-D / FIX 16). Defined now so the
 * value is in one place across PRs.
 */
export const WALKIN_GROUP_BUFFER_MS = 30 * 60 * 1000;

/**
 * Smart-scheduler client-side timeout — caller fires this when
 * `loadGroupSmartSchedule` has been running this long without
 * returning. Matches the staged-loading "timeout" phase already
 * shipped in PR #150 (`BookingGroupFlow.tsx` latencyPhase chain).
 * Kept here so future code paths don't reinvent the 20s figure.
 */
export const SCHEDULER_TIMEOUT_MS = 20 * 1000;

/**
 * Absolute safety ceiling for group size. The *effective* cap is
 * `Math.min(activeStaffCount, GROUP_MAX_SIZE)` — a salon with 3
 * active staff can host at most a 3-person group regardless of this
 * constant. This value is therefore just an upper guard rail for
 * very large salons; it is NOT an arbitrary business constraint.
 *
 * DB `insert_group_bookings` RPC enforces the same range
 * (`20260527000000_group_booking_dynamic_capacity` raised the RPC cap
 * to 20 in lock-step with this constant). Raises the previous
 * hardcoded ceiling of 6 (UI) / 8 (DB) to a single shared value of
 * 20 so a 15-staff nail bar can still accommodate large parties.
 */
export const GROUP_MAX_SIZE = 20;

/**
 * Task #05 — smart-alternatives "next available date" sub-query
 * horizon. When the group can't fit on the requested date the
 * scheduler probes the next N salon-local days in parallel to find
 * the soonest day that DOES fit. Capped at 5 (≈ one work week)
 * because:
 *   - 7 was the original spec but 5 is enough to bracket any
 *     non-holiday week without triggering an extra round of
 *     opening-hours-closed days in the middle
 *   - each probe is a full `loadGroupSmartSchedule` run; 5 in
 *     parallel is the upper bound on Supabase connection
 *     pressure we want from a single user impression
 */
export const ALTERNATIVE_SEARCH_DAYS = 5;

/**
 * Task #05 — per-sub-query timeout for the smart-alternatives
 * fan-out. Each sub-query races against this clock; whichever
 * ones don't return inside the budget are dropped from the
 * results card list. 5 s sits inside the user-perceived "loading
 * is still OK" window — the parent flow already shows the
 * `schedulingStillWorking` copy after 10 s, so the alternatives
 * results card has room to render before that nag fires.
 */
export const ALTERNATIVE_QUERY_TIMEOUT_MS = 5 * 1000;

/**
 * Task #05 — minimum gap between the main group's wall-clock
 * end and the "late" member's start in a split-option
 * arrangement. 15 min matches `SLOT_STEP_MIN` in the scheduler,
 * which keeps the late member's start aligned to the same grid
 * as the rest of the day and lets the salon flip the chair
 * cleanly between guests.
 */
export const SPLIT_LATE_BUFFER_MIN = 15;
