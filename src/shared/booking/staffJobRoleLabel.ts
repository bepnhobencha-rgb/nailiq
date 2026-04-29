export function formatStaffJobRole(jobRole: string): string {
  const r = jobRole.trim().toLowerCase();
  if (r === "owner") return "Owner";
  if (r === "senior") return "Senior";
  if (r === "nail_tech") return "Nail Tech";
  return jobRole;
}
