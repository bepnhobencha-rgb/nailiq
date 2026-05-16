import { redirect } from "next/navigation";

/**
 * `/superadmin/support` now redirects to its first live sub-route
 * (audit logs, Phase 1F). Once impersonation UI and other support
 * tools land, this can either grow into a real index or keep
 * redirecting to the most-trafficked sub-page.
 */
export default function SupportIndexPage(): never {
  redirect("/superadmin/support/audit-logs");
}
