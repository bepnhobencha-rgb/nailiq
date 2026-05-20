import { type ReactNode } from "react";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { ImpersonationBanner } from "@/components/impersonation/ImpersonationBanner";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { loadOwnerSalons } from "@/shared/dashboard/salonOwnerActions";
import { expireImpersonationIfStale } from "@/shared/superadmin/impersonationActions";
import { salonDayRangeUtc, salonToday } from "@/shared/lib/salonTime";
import { parseSubscriptionPlan } from "@/shared/lib/subscriptionPlans";

type Props = {
  children: ReactNode;
  params: Promise<{ slug: string }>;
};

/**
 * App-shell for `/dashboard/[slug]/*`. Resolves salon membership once
 * here so each child page doesn't re-fetch the role + salon name for
 * the sidebar. Pages still gate access independently — if a request
 * has no membership the layout renders bare children and the page's
 * own auth guard performs the redirect (keeps redirect targets per-
 * page rather than centralising them here).
 *
 * For owners, also pre-fetches the list of salons the user owns so
 * the sidebar footer can render a switcher dropdown without an extra
 * client-side roundtrip. Skipped for non-owners (the switcher is
 * owner-only — see `loadOwnerSalons` doc).
 */
export default async function DashboardSlugLayout({
  children,
  params,
}: Props) {
  const { slug } = await params;

  // Force-expire any stale impersonation BEFORE we resolve the
  // dashboard context. If the 30-min window has elapsed,
  // `expireImpersonationIfStale` writes an `impersonate_expire`
  // audit row, clears both impersonation cookies, and signs out
  // the now-stale owner session. The subsequent `getDashboardWriteClient`
  // call will then see no auth and fall through to the standard
  // redirect-to-login path.
  await expireImpersonationIfStale();

  const ctx = await getDashboardWriteClient(slug);

  if (!ctx) {
    // No auth / no membership / demo-gate failed — let the child page
    // perform its own redirect (e.g. to /register or /choose-salon).
    return <>{children}</>;
  }

  // Force-wizard gate (added 2026-05-09): a salon with
  // setup_wizard_completed_at IS NULL has not been through
  // /register/setup yet (placeholder name, no timezone confirmation).
  // Block dashboard access until the owner completes the wizard so
  // guest-facing screens never render with bad identity data.
  // Cast: column not yet in auto-generated DB types.
  const wizardGate = (await ctx.supabase
    .from("salons")
    .select("setup_wizard_completed_at" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle()) as {
    data: { setup_wizard_completed_at?: string | null } | null;
    error: unknown;
  };
  if (
    wizardGate.data &&
    wizardGate.data.setup_wizard_completed_at == null
  ) {
    redirect("/register/setup");
  }

  const salonName = (ctx.salon.name ?? "").trim() || slug;

  const salons =
    ctx.role === "owner" ? await loadOwnerSalons(slug) : [];

  // Live-board badge counters for the sidebar Walk-in Queue row.
  // Two queries (waiting + overdue) are issued in parallel; we tolerate
  // either failing (badge just hides). True realtime updates piggyback
  // on per-page navigation — the layout re-renders on every route
  // change so counts stay reasonably fresh without a client-side
  // postgres_changes subscription at the layout level.
  const { startUtc: todayStartUtc } = salonDayRangeUtc(
    salonToday(ctx.salon.timezone),
    ctx.salon.timezone,
  );

  const [waitingRes, overdueRes] = await Promise.all([
    ctx.supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("salon_id", ctx.salon.id)
      .eq("status", "waiting")
      .gte("joined_queue_at", todayStartUtc),
    ctx.supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("salon_id", ctx.salon.id)
      .eq("status", "in_progress")
      .lt("end_time_utc", new Date().toISOString()),
  ]);
  const walkinQueueCount = waitingRes.count ?? 0;
  const overdueCount = overdueRes.count ?? 0;

  const { data: planRow } = await ctx.supabase
    .from("salons")
    .select("subscription_plan, plan_override" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const subscriptionPlan = parseSubscriptionPlan(
    (planRow as { subscription_plan?: unknown } | null)?.subscription_plan,
  );

  return (
    <>
      <ImpersonationBanner />
      <DashboardShell
        slug={slug}
        role={ctx.role}
        salonName={salonName}
        salons={salons}
        walkinQueueCount={walkinQueueCount}
        overdueCount={overdueCount}
        subscriptionPlan={subscriptionPlan}
      >
        {children}
      </DashboardShell>
    </>
  );
}
