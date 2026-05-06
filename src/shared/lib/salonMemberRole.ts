/**
 * `salon_members.role` shape + helpers shared between auth, dashboard, and
 * routing surfaces. Mirrors `staff.job_role` from `setupActions.ts` but is
 * the canonical type for the membership row, not the staff catalog row.
 */
export type SalonMemberRole = "owner" | "senior" | "nail_tech";

export const SALON_MEMBER_ROLES: readonly SalonMemberRole[] = [
  "owner",
  "senior",
  "nail_tech",
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
  if (v === "senior") return "senior";
  if (v === "nail_tech") return "nail_tech";
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
