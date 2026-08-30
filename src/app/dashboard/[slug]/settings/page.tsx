import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SalonSettingsHub } from "@/components/dashboard/SalonSettingsHub";
import { GuidedSetupReturnCard } from "@/components/dashboard/GuidedSetupReturnCard";
import { parseDashboardModules } from "@/shared/dashboard/dashboardModules";
import { parsePresetKey } from "@/shared/dashboard/dashboardPresets";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { loadOwnerSalons } from "@/shared/dashboard/salonOwnerActions";
import { parseClientSegmentSettings } from "@/shared/dashboard/clientSegmentSettings";
import {
  AI_AGENT_FLAG_KEYS,
  type AiAgentFlags,
} from "@/shared/dashboard/aiAgentTypes";
import { getSalonDomain } from "@/shared/dashboard/domainActions";
import { normalizeBrandColor } from "@/shared/lib/brandColor";
import { parseSubscriptionPlan } from "@/shared/lib/subscriptionPlans";
import { getLookPresetsForVertical } from "@/shared/verticals/lookPresets";
import { resolveVertical } from "@/shared/verticals/registry";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import { loadSalonOwnerAdminSettingsForDashboardContext } from "@/shared/dashboard/salonOwnerAdminSettings";
import { normalizeGroupWaveStrategy } from "@/shared/booking/groupWaveOptimizer";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ section?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Settings · ${slug}`,
    description: "Manage services, staff, opening hours, and salon address.",
  };
}

export default async function SalonSettingsPage({
  params,
  searchParams,
}: Props) {
  const { slug } = await params;
  const requestedSection = (await searchParams).section;
  const guidedStep =
    requestedSection === "integrations" ? "integrations" : "communications";
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }
  // Settings contain business configuration, contact details, billing state,
  // messaging controls, and integration metadata. Hiding individual controls
  // in the client is not an authorization boundary: reject direct deep links
  // from operational staff before the first settings read occurs.
  if (!isOwnerOrAdmin(ctx.role)) {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  const managementSettings =
    await loadSalonOwnerAdminSettingsForDashboardContext(ctx);
  if (!managementSettings.ok) {
    console.error(
      "[SalonSettingsPage] owner/admin settings unavailable",
      managementSettings.code,
    );
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }
  const modRow = managementSettings.settings;

  const row = (modRow ?? null) as {
    dashboard_modules?: unknown;
    dashboard_preset?: unknown;
    email?: unknown;
    email_verified?: unknown;
    subscription_plan?: unknown;
    brand_color?: unknown;
    logo_url?: unknown;
    theme_mode?: unknown;
    walkin_auto_assign?: unknown;
    queue_display_mode?: unknown;
    phone_otp_enabled?: unknown;
    reminders_enabled?: unknown;
    reminder_24h_enabled?: unknown;
    reminder_3h_enabled?: unknown;
    sms_reminders_enabled?: unknown;
    booking_verification_mode?: unknown;
    google_review_url?: unknown;
    google_place_id?: unknown;
    yelp_business_id?: unknown;
    voice_ai_enabled?: unknown;
    voice_ai_persona_name?: unknown;
    vertical?: unknown;
    staff_selection_enabled?: unknown;
    booking_lead_minutes?: unknown;
    group_together_threshold_minutes?: unknown;
    group_wave_strategy?: unknown;
    reference_image_enabled?: unknown;
    auto_no_show_minutes?: unknown;
    winback_enabled?: unknown;
    client_segment_settings?: unknown;
    feature_flags?: unknown;
    resources_enabled?: unknown;
    primary_grid_axis?: unknown;
    sms_outbound_enabled?: unknown;
    email_outbound_enabled?: unknown;
    owner_notification_channel?: unknown;
    owner_phone?: unknown;
  } | null;

  const dashboardModules = parseDashboardModules(row?.dashboard_modules);
  const dashboardPreset = parsePresetKey(row?.dashboard_preset);
  // Module layout is structural — only owner can reorganize dashboard panels.
  const canEditDashboardModules = ctx.role === "owner";
  // All operational settings (booking rules, voice AI, no-show, reminders…)
  // are available to both owner and admin.
  const canManageSalonSettings = isOwnerOrAdmin(ctx.role);

  const salonEmail =
    typeof row?.email === "string" && row.email.trim().length > 0
      ? row.email.trim()
      : null;
  const emailVerified = row?.email_verified === true;
  const subscriptionPlan = parseSubscriptionPlan(row?.subscription_plan);
  const brandColor = normalizeBrandColor(row?.brand_color);
  const logoUrl =
    typeof row?.logo_url === "string" && row.logo_url.trim()
      ? row.logo_url.trim()
      : null;
  const themeMode: "dark" | "light" =
    row?.theme_mode === "light" ? "light" : "dark";
  // Default true when the column comes back null/missing (pre-migration
  // safety; column has NOT NULL DEFAULT true in 20260511100000).
  const walkinAutoAssign = row?.walkin_auto_assign === false ? false : true;
  const queueDisplayMode: "simple" | "full" =
    row?.queue_display_mode === "simple" ? "simple" : "full";
  const phoneOtpEnabled = row?.phone_otp_enabled === true;
  // Reminder aggregate state — defaults ON for new salons (seeded at registration).
  const remindersEnabled = row?.reminders_enabled === true;
  const reminder24hEnabled = row?.reminder_24h_enabled !== false;
  const reminder3hEnabled = row?.reminder_3h_enabled !== false;
  const smsRemindersEnabled = row?.sms_reminders_enabled === true;
  const googleReviewUrl =
    typeof row?.google_review_url === "string" &&
    row.google_review_url.trim().length > 0
      ? row.google_review_url.trim()
      : null;
  const googlePlaceId =
    typeof row?.google_place_id === "string" &&
    row.google_place_id.trim().length > 0
      ? row.google_place_id.trim()
      : null;
  const yelpBusinessId =
    typeof row?.yelp_business_id === "string" &&
    row.yelp_business_id.trim().length > 0
      ? row.yelp_business_id.trim()
      : null;
  const voiceAiEnabled = row?.voice_ai_enabled === true;
  const voiceAiPersonaName =
    typeof row?.voice_ai_persona_name === "string" &&
    row.voice_ai_persona_name.trim().length > 0
      ? row.voice_ai_persona_name.trim()
      : "Lily";
  const bookingVerificationMode =
    typeof row?.booking_verification_mode === "string"
      ? row.booking_verification_mode
      : undefined;
  const vertical =
    typeof row?.vertical === "string" && row.vertical.trim().length > 0
      ? row.vertical.trim()
      : "nail_salon";

  const domainInfo = await getSalonDomain(slug);
  const {
    data: { user: authUser },
  } = await ctx.supabase.auth.getUser();
  const userEmail = authUser?.email ?? null;
  const salonName = (ctx.salon.name ?? "").trim() || slug;
  const ownerSalons = ctx.role === "owner" ? await loadOwnerSalons(slug) : [];
  const lookPresets = getLookPresetsForVertical(vertical);
  const staffSelectionEnabled = row?.staff_selection_enabled !== false;
  const bookingLeadMinutes = (() => {
    const v = Number(row?.booking_lead_minutes);
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : 15;
  })();
  const groupTogetherThresholdMin = (() => {
    const v = Number(row?.group_together_threshold_minutes);
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : 30;
  })();
  const groupWaveStrategy = normalizeGroupWaveStrategy(
    row?.group_wave_strategy,
  );
  // Effective reference-image setting: explicit override, else vertical default.
  const referenceImageEnabled =
    row?.reference_image_enabled === true ||
    row?.reference_image_enabled === false
      ? row.reference_image_enabled
      : resolveVertical(vertical).referenceImageEnabled;
  const autoNoShowMinutes = (() => {
    const v = Number(row?.auto_no_show_minutes);
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
  })();
  // Win-back defaults ON (column default true); only explicit false disables.
  const winBackEnabled = row?.winback_enabled !== false;
  // Clients lifecycle thresholds (NULL → app defaults).
  const clientSegments = parseClientSegmentSettings(
    row?.client_segment_settings,
  );
  // AI agent feature flags from salons.feature_flags JSONB (all default OFF).
  const rawFlags = (row?.feature_flags ?? {}) as Record<string, unknown>;
  const aiFlags = Object.fromEntries(
    AI_AGENT_FLAG_KEYS.map((k) => [k, rawFlags[k] === true]),
  ) as AiAgentFlags;
  const aiManagerInstructions =
    (row as { ai_manager_instructions?: string | null } | null)
      ?.ai_manager_instructions ?? null;

  const ownerNotifChannel = (
    ["email", "sms", "both"].includes(
      String(row?.owner_notification_channel ?? ""),
    )
      ? row?.owner_notification_channel
      : "email"
  ) as "email" | "sms" | "both";
  const ownerPhone =
    typeof row?.owner_phone === "string" ? row.owner_phone : null;

  const resourcesEnabled = row?.resources_enabled === true;
  const primaryGridAxis: "staff" | "resource" =
    row?.primary_grid_axis === "resource" ? "resource" : "staff";

  // Messaging & Email settings — default ON when column is null (pre-migration safety).
  const smsOutboundEnabled = row?.sms_outbound_enabled !== false;
  const emailOutboundEnabled = row?.email_outbound_enabled !== false;
  const guidedSetupEnabled = await isReleaseFeatureVisible(
    { feature_flags: row?.feature_flags },
    "guided_admin_setup",
  );

  return (
    <div className="space-y-5">
      {guidedSetupEnabled ? (
        <GuidedSetupReturnCard slug={slug} currentStep={guidedStep} />
      ) : null}
      <SalonSettingsHub
        guidedFocusSection={
          guidedSetupEnabled
            ? guidedStep === "integrations"
              ? "integrations"
              : "notifications"
            : null
        }
        slug={slug}
        dashboardModules={dashboardModules}
        dashboardPreset={dashboardPreset}
        canEditDashboardModules={canEditDashboardModules}
        canManageSalonSettings={canManageSalonSettings}
        salonEmail={salonEmail}
        emailVerified={emailVerified}
        subscriptionPlan={subscriptionPlan}
        brandColor={brandColor}
        logoUrl={logoUrl}
        themeMode={themeMode}
        walkinAutoAssign={walkinAutoAssign}
        queueDisplayMode={queueDisplayMode}
        phoneOtpEnabled={phoneOtpEnabled}
        remindersEnabled={remindersEnabled}
        reminder24hEnabled={reminder24hEnabled}
        reminder3hEnabled={reminder3hEnabled}
        smsRemindersEnabled={smsRemindersEnabled}
        bookingVerificationMode={bookingVerificationMode}
        googleReviewUrl={googleReviewUrl}
        googlePlaceId={googlePlaceId}
        yelpBusinessId={yelpBusinessId}
        voiceAiEnabled={voiceAiEnabled}
        voiceAiPersonaName={voiceAiPersonaName}
        vertical={vertical}
        domainInfo={domainInfo}
        lookPresets={lookPresets}
        staffSelectionEnabled={staffSelectionEnabled}
        bookingLeadMinutes={bookingLeadMinutes}
        groupTogetherThresholdMin={groupTogetherThresholdMin}
        groupWaveStrategy={groupWaveStrategy}
        referenceImageEnabled={referenceImageEnabled}
        autoNoShowMinutes={autoNoShowMinutes}
        winBackEnabled={winBackEnabled}
        clientNewMaxVisits={clientSegments.newMaxVisits}
        clientAtRiskDays={clientSegments.atRiskDays}
        aiFlags={aiFlags}
        aiManagerInstructions={aiManagerInstructions}
        ownerNotifChannel={ownerNotifChannel}
        ownerPhone={ownerPhone}
        userEmail={userEmail}
        role={ctx.role}
        salonName={salonName}
        salons={ownerSalons}
        resourcesEnabled={resourcesEnabled}
        primaryGridAxis={primaryGridAxis}
        smsOutboundEnabled={smsOutboundEnabled}
        emailOutboundEnabled={emailOutboundEnabled}
      />
    </div>
  );
}
