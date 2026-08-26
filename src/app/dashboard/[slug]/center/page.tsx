import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  ReceptionistCenter,
  type ReceptionistRecoveryPrefill,
} from "@/components/receptionist/ReceptionistCenter";
import { ReceptionistErrorBoundary } from "@/components/receptionist/ReceptionistErrorBoundary";
import { loadBookingLimitStatus } from "@/shared/dashboard/loadBookingLimitStatus";
import { loadReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";
import { loadPartyCardsAction } from "@/shared/dashboard/loadPartyCardsAction";
import { isArchivedBookingFeatureAvailable } from "@/shared/dashboard/archivedBookingFeatureAccess";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { userEn } from "@/shared/i18n/user";
import {
  formatInSalonTz,
  salonToday,
  salonYmdOfUtc,
} from "@/shared/lib/salonTime";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";
import { loadPlatformDisabledFeatures } from "@/shared/features/platformFeatureFlags";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    date?: string;
    e2eNow?: string;
    recover?: string;
    recoveryKind?: string;
    shell?: string;
  }>;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Tiếp Tân · ${slug}`,
    robots: "noindex",
  };
}

export default async function ReceptionistCenterPage({
  params,
  searchParams,
}: PageProps) {
  const { slug } = await params;
  const { date, e2eNow, recover, recoveryKind, shell } = await searchParams;

  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }

  // Perf — `resolveSalonForDashboard` now fetches `timezone` alongside
  // the rest of the salon row, so we can compute today without a
  // dedicated round-trip. Previously this page issued THREE separate
  // `salons` queries per request (auth, this timezone lookup, and
  // `loadReceptionistCenterData`'s own fetch). The pre-fetched salon
  // is also handed to the loader below so it can skip its own fetch.
  const tz = ctx.salon.timezone.trim();
  if (!tz) {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }
  const dateOk = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const targetDate = dateOk ? date : salonToday(tz);
  const e2eClock =
    process.env.NAILIQ_TEST_BYPASS_SLUG_PIN === "1" &&
    slug.startsWith("e2e-") &&
    typeof e2eNow === "string" &&
    Number.isFinite(Date.parse(e2eNow))
      ? new Date(e2eNow).toISOString()
      : undefined;

  const [initialResult, limitResult, partyCardsResult] = await Promise.all([
    loadReceptionistCenterData(slug, targetDate, {
      preFetchedSalon: ctx.salon,
      observedAtIso: e2eClock,
    }),
    loadBookingLimitStatus(slug),
    loadPartyCardsAction(slug),
  ]);
  const bookingLimitStatus = limitResult.ok ? limitResult.status : null;

  if (!initialResult.ok && initialResult.error === "unauthorized") {
    redirect("/register");
  }

  // PR2: resolve Beta release flags that gate in-board surfaces (party-card
  // strip → group_booking, TV preset → tv_mode). Server-resolved so the client
  // component receives plain booleans.
  const flagSalon = ctx.salon;
  const groupBookingEnabled = isReleaseFeatureEnabled(flagSalon, "group_booking");
  const tvModeEnabled = isReleaseFeatureEnabled(flagSalon, "tv_mode");
  const featureFlags = flagSalon.feature_flags as Record<string, unknown> | null | undefined;
  const drcAccentColor =
    typeof featureFlags?.drc_accent_color === "string"
      ? featureFlags.drc_accent_color
      : null;
  const drcBgColor =
    typeof featureFlags?.drc_bg_color === "string"
      ? featureFlags.drc_bg_color
      : null;
  const receptionistPreviewBgColor =
    typeof featureFlags?.receptionist_preview_bg_color === "string"
      ? featureFlags.receptionist_preview_bg_color
      : null;

  // Hard URL enforcement: the sidebar hides the nav, but a direct visit to
  // /center must also be blocked when the feature is off. effective =
  // !platformDisabled && per-salon (platform overrides per-salon).
  const platformDisabled = await loadPlatformDisabledFeatures();
  const featureVisible = (key: Parameters<typeof isReleaseFeatureEnabled>[1]) =>
    !platformDisabled.has(key) && isReleaseFeatureEnabled(flagSalon, key);
  const receptionistShellPreview =
    shell === "v2" &&
    (process.env.VERCEL_ENV === "preview" ||
      (process.env.NAILIQ_TEST_BYPASS_SLUG_PIN === "1" &&
        slug.startsWith("e2e-")));
  const receptionistShellV2Enabled =
    featureVisible("receptionist_shell_v2") || receptionistShellPreview;
  const waitlistAttentionEnabled = featureVisible("waitlist_attention");

  const archivedBookingRecoveryEnabled =
    await isArchivedBookingFeatureAvailable(ctx.salon);

  // Archived rows stay immutable. The URL carries only the source UUID and
  // recovery kind; customer details are loaded server-side after proving:
  // feature flag ON + owner/admin role + same-salon row + terminal status.
  // Any malformed, cross-tenant, stale, or mismatched link fails closed and
  // simply opens the normal Center without a prefilled form.
  let recoveryPrefill: ReceptionistRecoveryPrefill | null = null;
  const validRecoveryKind =
    recoveryKind === "cancelled_rebook" || recoveryKind === "no_show_walkin";
  if (
    archivedBookingRecoveryEnabled &&
    isOwnerOrAdmin(ctx.role) &&
    typeof recover === "string" &&
    UUID_RE.test(recover) &&
    validRecoveryKind
  ) {
    const expectedStatus =
      recoveryKind === "cancelled_rebook" ? "cancelled" : "no_show";
    const [{ data: source }, { data: existingRecovery }] = await Promise.all([
      ctx.supabase
        .from("bookings")
        .select(
          "id, status, client_name, client_phone, client_email, client_notes, service_id, staff_id, start_time_utc",
        )
        .eq("id", recover)
        .eq("salon_id", ctx.salon.id)
        .eq("status", expectedStatus)
        .maybeSingle(),
      ctx.supabase
        .from("bookings")
        .select("id")
        .eq("salon_id", ctx.salon.id)
        .eq("recovered_from_booking_id" as never, recover)
        .limit(1)
        .maybeSingle(),
    ]);

    if (source?.id && !existingRecovery?.id && initialResult.ok) {
      const currentServiceIds = new Set(
        initialResult.data.services.map((service) => service.id),
      );
      const currentStaffIds = new Set(
        initialResult.data.staff.map((staff) => staff.id),
      );
      const serviceId =
        typeof source.service_id === "string" &&
        currentServiceIds.has(source.service_id)
          ? source.service_id
          : null;
      const clientName =
        typeof source.client_name === "string" ? source.client_name : "";
      const clientPhone =
        typeof source.client_phone === "string" ? source.client_phone : "";

      if (recoveryKind === "cancelled_rebook") {
        const startIso =
          typeof source.start_time_utc === "string"
            ? source.start_time_utc
            : "";
        const startMs = Date.parse(startIso);
        const observedNowMs = Date.parse(initialResult.data.observedAtIso);
        const originalTimeStillFuture =
          Number.isFinite(startMs) &&
          Number.isFinite(observedNowMs) &&
          startMs > observedNowMs;
        recoveryPrefill = {
          kind: "cancelled_rebook",
          sourceBookingId: String(source.id),
          clientName,
          clientPhone,
          clientEmail:
            typeof source.client_email === "string"
              ? source.client_email
              : null,
          clientNotes:
            typeof source.client_notes === "string"
              ? source.client_notes
              : null,
          serviceId,
          staffId:
            typeof source.staff_id === "string" &&
            currentStaffIds.has(source.staff_id)
              ? source.staff_id
              : null,
          originalYmd: originalTimeStillFuture
            ? salonYmdOfUtc(startIso, tz)
            : null,
          originalSlotLabel: originalTimeStillFuture
            ? formatInSalonTz(startIso, tz, "time")
            : null,
        };
      } else {
        recoveryPrefill = {
          kind: "no_show_walkin",
          sourceBookingId: String(source.id),
          clientName,
          clientPhone,
          serviceId,
        };
      }
    }
  }

  if (!featureVisible("receptionist_center")) {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  // Walk-in queue off → hide the panel + quick-add inside the board too, not
  // just the nav. Overriding the modules makes every existing
  // `modules.queue_panel` / `modules.quick_add` gate hide it.
  if (initialResult.ok && !featureVisible("walkin_queue")) {
    initialResult.data.dashboardModules = {
      ...initialResult.data.dashboardModules,
      queue_panel: false,
      quick_add: false,
    };
  }

  // Error-boundary labels are sourced server-side from English (the
  // primary product language per UX_PRINCIPLES §7). The boundary
  // surface is rare; a follow-up can fold a client wrapper that
  // reads `useUserLanguage` for VI parity if real-world incidents
  // make that worthwhile.
  return (
    <ReceptionistErrorBoundary
      labels={userEn.receptionist.errorBoundary}
      salonSlug={slug}
    >
      <ReceptionistCenter
        slug={slug}
        initialResult={initialResult}
        viewerRole={ctx.role}
        bookingLimitStatus={bookingLimitStatus}
        partyCards={partyCardsResult.ok ? partyCardsResult.cards : []}
        groupBookingEnabled={groupBookingEnabled}
        tvModeEnabled={tvModeEnabled}
        accentColor={drcAccentColor}
        bgColor={drcBgColor}
        previewBgColor={receptionistPreviewBgColor}
        archivedBookingRecoveryEnabled={archivedBookingRecoveryEnabled}
        receptionistShellV2Enabled={receptionistShellV2Enabled}
        waitlistAttentionEnabled={waitlistAttentionEnabled}
        recoveryPrefill={recoveryPrefill}
      />
    </ReceptionistErrorBoundary>
  );
}
