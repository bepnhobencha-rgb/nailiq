import { type ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { redirect } from "next/navigation";
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
import { resolveFeatureVisibility } from "@/shared/features/featureRegistry";
import { loadPlatformDisabledFeatures } from "@/shared/features/platformFeatureFlags";
import { getPendingApprovals } from "@/shared/ai/approvalRequests";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { SubscriptionDeadlineNotice } from "@/components/dashboard/SubscriptionDeadlineNotice";
import { getPrivateOfferBySalonId } from "@/shared/sales/privateOffers";
import {
  loadDashboardAnnouncements,
  loadPlatformNotificationPreference,
} from "@/shared/dashboard/platformAnnouncements";
import { shouldCountPlatformAnnouncement } from "@/shared/dashboard/platformAnnouncementPresentation";
import { PlatformAnnouncementBanner } from "@/components/dashboard/PlatformAnnouncementBanner";
import { TrialSetupProgressBanner } from "@/components/dashboard/TrialSetupProgressBanner";
import { GuidedFocusVisibility } from "@/components/dashboard/GuidedFocusVisibility";
import { loadGoLiveReadiness } from "@/shared/dashboard/loadGoLiveReadiness";
import { loadDashboardShellProjection } from "@/shared/dashboard/loadDashboardShellProjection";
import {
  deriveGuidedSetupProgress,
  resolveGuidedSetupStage,
  type GuidedSetupProgress,
  type GuidedSetupStage,
} from "@/shared/dashboard/guidedSetup";
import { isCocoSetupActivated } from "@/shared/dashboard/cocoSetupActivation";

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
export default async function DashboardSlugLayout({ children, params }: Props) {
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

  const { startUtc: todayStartUtc } = salonDayRangeUtc(
    salonToday(ctx.salon.timezone),
    ctx.salon.timezone,
  );
  const shellProjection = await loadDashboardShellProjection(
    ctx.salon.id,
    todayStartUtc,
  );

  // Force-wizard gate (added 2026-05-09): a salon with
  // setup_wizard_completed_at IS NULL has not been through
  // /register/setup yet (placeholder name, no timezone confirmation).
  // Block dashboard access until the owner completes the wizard so
  // guest-facing screens never render with bad identity data.
  // Cast: column not yet in auto-generated DB types.
  let wizardIncomplete: boolean;
  if (shellProjection) {
    wizardIncomplete = shellProjection.setupWizardCompletedAt == null;
  } else {
    const wizardGate = (await ctx.supabase
      .from("salons")
      .select("setup_wizard_completed_at" as never)
      .eq("id", ctx.salon.id)
      .maybeSingle()) as {
      data: { setup_wizard_completed_at?: string | null } | null;
      error: unknown;
    };
    wizardIncomplete = Boolean(
      wizardGate.data && wizardGate.data.setup_wizard_completed_at == null,
    );
  }
  if (wizardIncomplete) {
    redirect("/register/setup");
  }

  // The two personalized Hi-Lite offers passed their July 31 deadline. Keep
  // public salon pages and booking available, but do not render operational
  // Dashboard content until Stripe's signed webhook persists a subscription.
  // This is evaluated server-side on every Dashboard request: localStorage,
  // client-side CSS, or a direct nested URL cannot bypass the screen.
  const privateOffer = getPrivateOfferBySalonId(ctx.salon.id);
  if (privateOffer) {
    let subscriptionId = shellProjection?.stripeSubscriptionId?.trim();
    let status = shellProjection?.subscriptionStatus;
    if (!shellProjection) {
      const { data: billingRow } = await createServiceRoleClient()
        .from("salons")
        .select("stripe_subscription_id, subscription_status")
        .eq("id", ctx.salon.id)
        .maybeSingle();
      subscriptionId = (
        billingRow as { stripe_subscription_id?: string | null } | null
      )?.stripe_subscription_id?.trim();
      status = (billingRow as { subscription_status?: string | null } | null)
        ?.subscription_status;
    }
    const paid =
      Boolean(subscriptionId) && (status === "active" || status === "trialing");
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
  const {
    data: { user },
  } = await ctx.supabase.auth.getUser();
  const userEmail = user?.email ?? null;

  const salons = ctx.role === "owner" ? await loadOwnerSalons(slug) : [];

  // Live-board badge counters for the sidebar Walk-in Queue row.
  // Two queries (waiting + overdue) are issued in parallel; we tolerate
  // either failing (badge just hides). True realtime updates piggyback
  // on per-page navigation — the layout re-renders on every route
  // change so counts stay reasonably fresh without a client-side
  // postgres_changes subscription at the layout level.
  let walkinQueueCount: number;
  let waitlistCount: number;
  let overdueCount: number;
  let pendingApprovalsCount: number;
  if (shellProjection) {
    walkinQueueCount = shellProjection.waitingCount;
    waitlistCount = shellProjection.waitlistCount;
    overdueCount = shellProjection.overdueCount;
    pendingApprovalsCount =
      ctx.role === "owner" || ctx.role === "admin"
        ? shellProjection.pendingApprovalsCount
        : 0;
  } else {
    const [waitingRes, waitlistRes, overdueRes, pendingApprovals] =
      await Promise.all([
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
        ctx.role === "owner" || ctx.role === "admin"
          ? getPendingApprovals(ctx.salon.id)
          : Promise.resolve([]),
      ]);
    walkinQueueCount = waitingRes.count ?? 0;
    waitlistCount = waitlistRes.count ?? 0;
    overdueCount = overdueRes.count ?? 0;
    pendingApprovalsCount = pendingApprovals.length;
  }

  // Plan/feature inputs are part of the member-safe operational profile.
  // Billing state is not: only owner/admin may receive it, through a guarded
  // service-role read used solely for the trial banner.
  const billingPlanRow =
    ctx.role === "owner" || ctx.role === "admin"
      ? shellProjection
        ? {
            subscription_status: shellProjection.subscriptionStatus,
            trial_ends_at: shellProjection.trialEndsAt,
          }
        : (
            await createServiceRoleClient()
              .from("salons")
              .select("subscription_status, trial_ends_at" as never)
              .eq("id", ctx.salon.id)
              .maybeSingle()
          ).data
      : null;
  const billingPlan = (billingPlanRow ?? {}) as {
    subscription_status?: string | null;
    trial_ends_at?: string | null;
  };
  const flagSalon = {
    subscription_plan: ctx.salon.subscription_plan,
    plan_override: ctx.salon.plan_override,
    feature_flags: ctx.salon.feature_flags,
    voice_ai_enabled: ctx.salon.voice_ai_enabled,
    subscription_status: billingPlan.subscription_status,
    trial_ends_at: billingPlan.trial_ends_at,
  } as {
    subscription_plan?: string | null;
    subscription_status?: string | null;
    trial_ends_at?: string | null;
    plan_override?: string | null;
    feature_flags?: unknown;
    voice_ai_enabled?: boolean | null;
  };
  const subscriptionPlan = parseSubscriptionPlan(flagSalon.subscription_plan);
  const daysLeftInTrial = trialDaysRemaining(flagSalon.trial_ends_at);
  const [userLanguage, platformAnnouncements, platformNotificationPreference] = await Promise.all([
    resolveUserLanguage(),
    loadDashboardAnnouncements(ctx.role),
    loadPlatformNotificationPreference(),
  ]);
  const platformNoticeNowIso = new Date().toISOString();
  const productNoticeCount = platformAnnouncements.filter((announcement) =>
    shouldCountPlatformAnnouncement(announcement, {
      autoManageRoutine: platformNotificationPreference.autoManageRoutine,
      nowIso: platformNoticeNowIso,
    }),
  ).length;
  const isTrial =
    flagSalon.subscription_status === "trialing" && daysLeftInTrial != null;

  // Resolve release-feature visibility server-side so the client sidebar/shell
  // receive plain booleans (never the raw salon row). Now covers EVERY key
  // (base + beta) and ANDs in the platform-wide kill-switch: a feature is
  // visible only when it's not platform-disabled AND enabled for this salon.
  const platformDisabled = await loadPlatformDisabledFeatures();
  const releaseFeatures = resolveFeatureVisibility(flagSalon, platformDisabled);
  const cocoSetupVisible =
    isCocoSetupActivated(flagSalon) &&
    !platformDisabled.has("guided_admin_setup");
  let guidedSetupStage: GuidedSetupStage = "disabled";
  let guidedSetupProgress: GuidedSetupProgress | null = null;
  if (releaseFeatures.guided_admin_setup || cocoSetupVisible) {
    const setupResult = await loadGoLiveReadiness(slug);
    guidedSetupProgress = setupResult.ok
      ? deriveGuidedSetupProgress(slug, setupResult.readiness)
      : null;
    guidedSetupStage = resolveGuidedSetupStage(
      true,
      guidedSetupProgress?.complete ?? null,
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
        productNoticeCount={productNoticeCount}
      >
        <GuidedFocusVisibility stage={guidedSetupStage}>
          <PlatformAnnouncementBanner
            announcements={platformAnnouncements}
            language={userLanguage}
            slug={slug}
            autoManageRoutine={platformNotificationPreference.autoManageRoutine}
            nowIso={platformNoticeNowIso}
          />
          {isTrial ? (
            <TrialSetupProgressBanner
              slug={slug}
              language={userLanguage}
              daysLeft={daysLeftInTrial}
              completedCount={guidedSetupProgress?.completedCount ?? 0}
              requiredCount={guidedSetupProgress?.requiredCount ?? 0}
              percent={guidedSetupProgress?.percent ?? 0}
            />
          ) : null}
        </GuidedFocusVisibility>
        {children}
      </DashboardShell>
    </>
  );
}
