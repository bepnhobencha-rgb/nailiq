import { getImpersonationMeta } from "@/shared/superadmin/impersonationCookies";
import { ImpersonationBannerInner } from "./ImpersonationBannerInner";

/**
 * Server wrapper — reads the `nq-imp-meta` cookie and renders the
 * banner only when an impersonation is active. Inserting this at
 * the top of the dashboard layout is enough to gate visibility;
 * non-impersonating visitors get null and the layout collapses.
 *
 * Per `DASHBOARD_LAYOUT_RULES.md` §10.5 — sticky top, danger
 * color, contains the exit affordance and the 30-min countdown.
 */
export async function ImpersonationBanner() {
  const meta = await getImpersonationMeta();
  if (!meta) return null;
  return <ImpersonationBannerInner meta={meta} />;
}
