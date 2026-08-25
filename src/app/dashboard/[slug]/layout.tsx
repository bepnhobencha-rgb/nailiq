import { type ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { getSalonPwaInfo } from "@/shared/dashboard/salonPwaInfo";
import { ImpersonationBanner } from "@/components/impersonation/ImpersonationBanner";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { loadOwnerSalons } from "@/shared/dashboard/salonOwnerActions";
import { expireImpersonationIfStale } from "@/shared/superadmin/impersonationActions";
import { salonDayRangeUtc, salonToday } from "@/shared/lib/salonTime";
import { parseSubscriptionPlan } from "@/shared/lib/subscriptionPlans";
import { trialDaysRemaining } from "@/shared/lib/trial";
import { resolveUserLanguage } from "@/shared/i18n/user/resolveUserLanguage";
import {
  resolveFeatureVisibility,
} from "@/shared/features/featureRegistry";
import { loadPlatformDisabledFeatures } from "@/shared/features/platformFeatureFlags";
import { getPendingApprovals } from "@/shared/ai/approvalRequests";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { SubscriptionDeadlineNotice } from "@/components/dashboard/SubscriptionDeadlineNotice";
import { getPrivateOfferBySalonId } from "@/shared/sales/privateOffers";
import { loadDashboardAnnouncements } from "@/shared/dashboard/platformAnnouncements";
import { PlatformAnnouncementBanner } from "@/components/dashboard/PlatformAnnouncementBanner";
import { loadGoLiveReadiness } from "@/shared/dashboard/loadGoLiveReadiness";
import {
  deriveGuidedSetupProgress,
  resolveGuidedSetupStage,
  type GuidedSetupStage,
} from "@/shared/dashboard/guidedSetup";

type Props = {
  children: ReactNode;
  params: Promise<{ slug: string }>;
};

/**
 * Installable-PWA metadata so the salon dashboard adds to the phone home
 * screen as its own branded app (per-tenant manifest + generated icon),
 * launching standalone (no browser chrome). iOS uses the apple-* tags;
 * Android uses the manifest + service worker (registered in the shell).
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const seg = encodeURIComponent(slug);
  const info = await getSalonPwaInfo(slug);
  const name = info?.name ?? "NailIQ";
  return {
    title: { default: `${name} — Dashboard`, template: `%s · ${name}` },
    manifest: `/dashboard/${seg}/manifest.webmanifest`,
    appleWebApp: {
      capable: true,
      title: name,
      statusBarStyle: "black-translucent",
    },
    icons: {
      icon: `/dashboard/${seg}/icon?size=192`,
      apple: `/dashboard/${seg}/icon?size=180`,
    },
  };
}

export async function generateViewport(): Promise<Viewport> {
  // Dark status bar matches the dashboard for a seamless standalone look.
  return { themeColor: "#0B0C10" };
}

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

  // The two personalized Hi-Lite offers passed their July 31 deadline. Keep
  // public salon pages and booking available, but do not render operational
  // Dashboard content until Stripe's signed webhook persists a subscription.
  // This is evaluated server-side on every Dashboard request: localStorage,
  // client-side CSS, or a direct nested URL cannot bypass the screen.
  const privateOffer = getPrivateOfferBySalonId(ctx.salon.id);
  if (privateOffer) {
    const { data: billingRow } = await createServiceRoleClient()
      .from("salons")
      .select("stripe_subscription_id, subscription_status")
      .eq("id", ctx.salon.id)
      .maybeSingle();
    const subscriptionId = (billingRow as { stripe_subscription_id?: string | null } | null)
      ?.stripe_subscription_id?.trim();
    const status = (billingRow as { subscription_status?: string | null } | null)
      ?.subscription_status;
    const paid = Boolean(subscriptionId) && (status === "active" || status === "trialing");
    if (!paid) {
      return (
        <SubscriptionDeadlineNotice
          salonName={privateOffer.salonName}
          offerUrl={`/offer/${encodeURIComponent(privateOffer.accessKey)}`}
        />
      );
    }
  }

  const salonName = (ctx.salon.name ?? "").trim() || slug;

  // Get authenticated user email from Supabase auth
  const { data: { user } } = await ctx.supabase.auth.getUser();
  const userEmail = user?.email ?? null;

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

  const [waitingRes, waitlistRes, overdueRes, pendingApprovals] = await Promise.all([
    ctx.supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("salon_id", ctx.salon.id)
      .eq("status", "waiting")
      .gte("joined_queue_at", todayStartUtc),
    // Online waitlist is a separate customer state from an in-salon walk-in.
    // Keep its badge separate so receptionists never mistake "waiting online"
    // for "physically waiting in the salon".
    (async () => {
      try {
        // The waitlist table is intentionally RLS-locked. This executes only
        // after membership has been verified above and returns a count, never
        // customer details, to the client shell.
        return await createServiceRoleClient()
          .from("booking_waitlist_entries")
          .select("id", { count: "exact", head: true })
          .eq("salon_id", ctx.salon.id)
          .in("status", ["waiting", "notified"]);
      } catch {
        return { count: 0 };
      }
    })(),
    // Bounded to today, like the waiting query above. Without a lower bound an
    // in_progress row nobody ever closed out stays overdue forever: one
    // abandoned booking from 10 days ago held the badge permanently red, which
    // trains staff to ignore it — the opposite of what an alert is for. The
    // stale rows themselves are swept by /api/cron/close-stale-in-progress.
    ctx.supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("salon_id", ctx.salon.id)
      .eq("status", "in_progress")
      .gte("start_time_utc", todayStartUtc)
      .lt("end_time_utc", new Date().toISOString()),
    // Only fetch pending approvals for owners/admins who can act on them
    (ctx.role === "owner" || ctx.role === "admin")
      ? getPendingApprovals(ctx.salon.id)
      : Promise.resolve([]),
  ]);
  const walkinQueueCount = waitingRes.count ?? 0;
  const waitlistCount = waitlistRes.count ?? 0;
  const overdueCount = overdueRes.count ?? 0;
  const pendingApprovalsCount = pendingApprovals.length;

  const { data: planRow } = await ctx.supabase
    .from("salons")
    .select(
      "subscription_plan, subscription_status, trial_ends_at, plan_override, feature_flags, voice_ai_enabled" as never,
    )
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const flagSalon = (planRow ?? {}) as {
    subscription_plan?: string | null;
    subscription_status?: string | null;
    trial_ends_at?: string | null;
    plan_override?: string | null;
    feature_flags?: unknown;
    voice_ai_enabled?: boolean | null;
  };
  const subscriptionPlan = parseSubscriptionPlan(flagSalon.subscription_plan);
  const daysLeftInTrial = trialDaysRemaining(flagSalon.trial_ends_at);
  const [userLanguage, platformAnnouncements] = await Promise.all([
    resolveUserLanguage(),
    loadDashboardAnnouncements(ctx.role),
  ]);
  const isTrial =
    flagSalon.subscription_status === "trialing" &&
    daysLeftInTrial != null;

  // Resolve release-feature visibility server-side so the client sidebar/shell
  // receive plain booleans (never the raw salon row). Now covers EVERY key
  // (base + beta) and ANDs in the platform-wide kill-switch: a feature is
  // visible only when it's not platform-disabled AND enabled for this salon.
  const platformDisabled = await loadPlatformDisabledFeatures();
  const releaseFeatures = resolveFeatureVisibility(flagSalon, platformDisabled);
  let guidedSetupStage: GuidedSetupStage = "disabled";
  if (releaseFeatures.guided_admin_setup) {
    const setupResult = await loadGoLiveReadiness(slug);
    guidedSetupStage = resolveGuidedSetupStage(
      true,
      setupResult.ok
        ? deriveGuidedSetupProgress(slug, setupResult.readiness).complete
        : null,
    );
  }

  return (
    <>
      <ImpersonationBanner />
      <DashboardShell
        slug={slug}
        role={ctx.role}
        salonName={salonName}
        salons={salons}
        walkinQueueCount={walkinQueueCount}
        waitlistCount={waitlistCount}
        overdueCount={overdueCount}
        pendingApprovalsCount={pendingApprovalsCount}
        subscriptionPlan={subscriptionPlan}
        releaseFeatures={releaseFeatures}
        userEmail={userEmail}
        salonId={ctx.salon.id}
        guidedSetupStage={guidedSetupStage}
      >
        <PlatformAnnouncementBanner
          announcements={platformAnnouncements}
          language={userLanguage}
        />
        {isTrial ? (
          <div
            className={`mx-4 mt-3 flex items-center justify-between gap-3 rounded-2xl border px-4 py-2.5 text-sm sm:mx-6 sm:mt-4 sm:py-3 ${
              daysLeftInTrial === 0
                ? "border-nq-error/40 bg-nq-error/10 text-nq-foreground"
                : "border-nq-primary/35 bg-nq-primary/10 text-nq-foreground"
            }`}
            role="status"
          >
            <p className="min-w-0 leading-snug">
              {daysLeftInTrial === 0
                ? userLanguage === "vi"
                  ? "Thời gian dùng thử 14 ngày đã kết thúc. Chọn gói để tiếp tục dùng các tính năng trả phí."
                  : "Your 14-day trial has ended. Choose a plan to keep using paid features."
                : userLanguage === "vi"
                  ? <><span className="sm:hidden">Còn {daysLeftInTrial} ngày dùng thử</span><span className="hidden sm:inline">Bạn còn {daysLeftInTrial} ngày dùng thử miễn phí. Chưa có khoản phí nào được tính.</span></>
                  : <><span className="sm:hidden">{daysLeftInTrial} trial day{daysLeftInTrial === 1 ? "" : "s"} left</span><span className="hidden sm:inline">{daysLeftInTrial} day{daysLeftInTrial === 1 ? "" : "s"} left in your free trial. No credit card has been charged.</span></>}
            </p>
            <Link
              href={`/dashboard/${encodeURIComponent(slug)}/settings#cat-plan`}
              className="shrink-0 text-xs font-semibold text-nq-primary-soft underline-offset-4 hover:underline sm:text-sm"
            >
              {userLanguage === "vi" ? "Xem các gói" : "View plans"}
            </Link>
          </div>
        ) : null}
        {children}
      </DashboardShell>
    </>
  );
}
