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
 * Hard cap on group size at the UI layer. The DB
 * `insert_group_bookings` RPC accepts 2–8 (`20260512300000` raised
 * the cap to 8), but the booking-page pill grid + capacity
 * checks treat 6 as the practical maximum — anything larger
 * stresses both salon layout and the scheduler's combinatorial
 * search. Per-salon effective cap is
 * `Math.min(activeStaffCount, GROUP_MAX_SIZE)`.
 */
export const GROUP_MAX_SIZE = 6;
