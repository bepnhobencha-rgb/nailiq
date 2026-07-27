/**
 * `salon_members.role` shape + helpers shared between auth, dashboard, and
 * routing surfaces. Mirrors `staff.job_role` from `setupActions.ts` but is
 * the canonical type for the membership row, not the staff catalog row.
 */
export type SalonMemberRole = "owner" | "admin" | "senior" | "nail_tech" | "receptionist";

export const SALON_MEMBER_ROLES: readonly SalonMemberRole[] = [
  "owner",
  "admin",
  "senior",
  "nail_tech",
  "receptionist",
] as const;

/**
 * Normalize a `salon_members.role` DB value into a known `SalonMemberRole`.
 *
 * Legacy rows may hold `NULL` or values written before the role union was
 * formalized. Unknown values must never gain management access, so they fall
 * back to the least-privileged schedule-only role. A data repair can restore
 * the intended role after the membership row has been reviewed.
 */
export function normalizeSalonMemberRole(raw: unknown): SalonMemberRole {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "admin") return "admin";
  if (v === "senior") return "senior";
  if (v === "nail_tech") return "nail_tech";
  if (v === "receptionist") return "receptionist";
  if (v === "owner") return "owner";
  return "nail_tech";
}

/**
 * Post-login redirect target by `salon_members.role`.
 *
 * - `owner` → `/dashboard/[slug]` (owner home: today's overview, settings, etc.)
 * - `senior`, `nail_tech` → `/dashboard/[slug]/center` (operational
 *   receptionist workspace; Phase 1 routes both staff roles to the same
 *   surface — Phase 2 will diverge nail_tech into a tighter view)
 */
export function dashboardPathForRole(
  slug: string,
  role: SalonMemberRole,
): string {
  const enc = encodeURIComponent(slug);
  // admin now has full settings access — route to owner home/pulse, not front-desk center
  return role === "owner" || role === "admin" ? `/dashboard/${enc}` : `/dashboard/${enc}/center`;
}

/**
 * Mutating-action permissions for booking rows in Receptionist Center.
 *
 * Editing and cancelling a booking are core front-desk jobs, so they mirror
 * the no-show / desk-booking / status set: owner/admin/senior/receptionist.
 * `nail_tech` stays view-only — they see the grid and drawer but can't modify
 * the schedule.
 *
 * (Previously this gate was owner/senior only, which wrongly locked an `admin`
 *  out of the Cancel button entirely even though the same admin could mark
 *  no-show and start/complete a service — see the Hi-Lite admin who couldn't
 *  cancel a 2pm appointment.)
 *
 * `canUndoCancel` shares the same set: undoing/restoring a cancellation is the
 * other half of cancelling, so whoever can cancel must be able to undo their
 * own mistake without escalating to an owner — otherwise broadening cancel to
 * admin/receptionist (#405) leaves them trapped after a wrong cancel.
 */
export function canEditBooking(role: SalonMemberRole): boolean {
  return (
    role === "owner" ||
    role === "admin" ||
    role === "senior" ||
    role === "receptionist"
  );
}

export function canCancelBooking(role: SalonMemberRole): boolean {
  return (
    role === "owner" ||
    role === "admin" ||
    role === "senior" ||
    role === "receptionist"
  );
}

/** Marking a no-show is a front-desk operation (the receptionist sees who
 *  didn't show), so it's broader than cancel: owner/admin/senior/receptionist. */
export function canMarkNoShow(role: SalonMemberRole): boolean {
  return (
    role === "owner" ||
    role === "admin" ||
    role === "senior" ||
    role === "receptionist"
  );
}

/** Booking a phone-in customer for a future date is a core front-desk job, so
 *  it's the same broad set as no-show: owner/admin/senior/receptionist. */
export function canCreateDeskBooking(role: SalonMemberRole): boolean {
  return (
    role === "owner" ||
    role === "admin" ||
    role === "senior" ||
    role === "receptionist"
  );
}

/** Controlled after-hours exceptions are management decisions, not routine
 * front-desk mutations. They require an authenticated Owner/Admin plus an
 * explicit selected-staff consent confirmation in the server action. */
export function canCreateAfterHoursDeskBooking(
  role: SalonMemberRole,
): boolean {
  return role === "owner" || role === "admin";
}

export function canUndoCancel(role: SalonMemberRole): boolean {
  return (
    role === "owner" ||
    role === "admin" ||
    role === "senior" ||
    role === "receptionist"
  );
}

/** Advancing a booking's status (confirm / start / complete) is a front-desk
 *  operation, so it mirrors the no-show / desk-booking set:
 *  owner/admin/senior/receptionist. `nail_tech` is excluded — they have a
 *  view-only booking surface (see `canEditBooking`) and shouldn't be able to
 *  flip a booking to completed (the test-click that wrongly closed a Hi-Lite
 *  appointment came through an ungated status change). */
export function canChangeBookingStatus(role: SalonMemberRole): boolean {
  return (
    role === "owner" ||
    role === "admin" ||
    role === "senior" ||
    role === "receptionist"
  );
}

// ─── Dashboard-action authorization predicates ───────────────────────────────
// Single source of truth for the role SETS that gate dashboard server actions,
// so "which roles count as owner-admin / front-desk" lives in one place instead
// of being re-spelled inline at ~50 call sites (where it had begun to drift).
// These name the SET only — each action keeps its own forbidden response.

/** Owner of the salon. Settings/billing/integration actions gate on this. */
export function isOwner(role: SalonMemberRole): boolean {
  return role === "owner";
}

/** Owner or admin — salon management (staff, services, config, AI prefill). */
export function isOwnerOrAdmin(role: SalonMemberRole): boolean {
  return role === "owner" || role === "admin";
}

/** Front-desk roles (everyone except a view-only `nail_tech`): owner / admin /
 *  senior / receptionist. The set that may read customer data + operate the
 *  desk. Mirrors the `can*Booking` action set. */
export function isFrontDeskRole(role: SalonMemberRole): boolean {
  return (
    role === "owner" ||
    role === "admin" ||
    role === "senior" ||
    role === "receptionist"
  );
}
