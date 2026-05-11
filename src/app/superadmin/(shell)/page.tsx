import { redirect } from "next/navigation";

/**
 * `/superadmin/` — canonical entry redirects to the Dashboard tab
 * (per `docs/DASHBOARD_LAYOUT_RULES.md` §10.4 the sidebar's primary
 * surface). Authenticated salon owners never reach here because the
 * shell layout's role gate already 404s them.
 */
export default function SuperadminIndex() {
  redirect("/superadmin/dashboard");
}
