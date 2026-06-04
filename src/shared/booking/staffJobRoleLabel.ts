/**
 * Display label for a staff member's `job_role`.
 *
 * The `nail_tech` value is the platform's stable internal key for the
 * front-line service-provider role; its DISPLAY label is vertical-specific
 * ("Nail Tech" for a nail salon, "Therapist" for a head spa, …). Callers that
 * know the salon's vertical pass `techLabel` from
 * `resolveVertical(salon.vertical).staffRoleLabel[lang]`; when omitted it
 * defaults to the historical "Nail Tech".
 */
export function formatStaffJobRole(jobRole: string, techLabel?: string): string {
  const r = jobRole.trim().toLowerCase();
  if (r === "owner") return "Owner";
  if (r === "senior") return "Senior";
  if (r === "nail_tech") return techLabel?.trim() || "Nail Tech";
  return jobRole;
}
