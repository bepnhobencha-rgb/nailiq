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
 * formalized. Default is `"owner"` — historically every membership row was
 * an owner, and owner is the most permissive role so a fallback to it does
 * not silently elevate. Any future migration should backfill explicit
 * values rather than relying on this default.
 */
export function normalizeSalonMemberRole(raw: unknown): SalonMemberRole {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "admin") return "admin";
  if (v === "senior") return "senior";
  if (v === "nail_tech") return "nail_tech";
  if (v === "receptionist") return "receptionist";
  return "owner";
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
  return role === "owner" ? `/dashboard/${enc}` : `/dashboard/${enc}/center`;
}

/**
 * Mutating-action permissions for booking rows in Receptionist Center.
 *
 * Phase 1 split: `nail_tech` is a view-only role for bookings — they see the
 * grid and drawer but can't modify the schedule. Owners and seniors can
 * still edit, cancel, and undo cancellations.
 *
 * The `canUndoCancel` helper currently has no consumer in the UI (there is
 * no undo-cancel flow yet — `UndoToast` is for walk-in assign). It's
 * exported here for parity with edit/cancel so a future undo-after-cancel
 * feature lands in the right gate from day one.
 */
export function canEditBooking(role: SalonMemberRole): boolean {
  return role === "owner" || role === "senior";
}

export function canCancelBooking(role: SalonMemberRole): boolean {
  return role === "owner" || role === "senior";
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

export function canUndoCancel(role: SalonMemberRole): boolean {
  return role === "owner" || role === "senior";
}
