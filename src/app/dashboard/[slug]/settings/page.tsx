import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SalonSettingsHub } from "@/components/dashboard/SalonSettingsHub";
import { parseDashboardModules } from "@/shared/dashboard/dashboardModules";
import { parsePresetKey } from "@/shared/dashboard/dashboardPresets";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { getSalonDomain } from "@/shared/dashboard/domainActions";
import { normalizeBrandColor } from "@/shared/lib/brandColor";
import { parseSubscriptionPlan } from "@/shared/lib/subscriptionPlans";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Settings · ${slug}`,
    description:
      "Manage services, staff, opening hours, and salon address.",
  };
}

export default async function SalonSettingsPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }

  const { data: modRow, error: modErr } = await ctx.supabase
    .from("salons")
    .select(
      "dashboard_modules, dashboard_preset, email, email_verified, subscription_plan, brand_color, theme_mode, walkin_auto_assign, queue_display_mode, phone_otp_enabled, reminders_enabled, reminder_24h_enabled, reminder_3h_enabled, sms_reminders_enabled, booking_verification_mode, google_review_url, voice_ai_enabled, voice_ai_persona_name",
    )
    .eq("id", ctx.salon.id)
    .maybeSingle();

  if (modErr) {
    console.error(
      "[SalonSettingsPage] dashboard_modules / dashboard_preset",
      modErr,
    );
  }

  const row = (modRow ?? null) as
    | {
        dashboard_modules?: unknown;
        dashboard_preset?: unknown;
        email?: unknown;
        email_verified?: unknown;
        subscription_plan?: unknown;
        brand_color?: unknown;
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
        voice_ai_enabled?: unknown;
        voice_ai_persona_name?: unknown;
      }
    | null;

  const dashboardModules = parseDashboardModules(row?.dashboard_modules);
  const dashboardPreset = parsePresetKey(row?.dashboard_preset);
  const canEditDashboardModules = ctx.role === "owner";

  const salonEmail =
    typeof row?.email === "string" && row.email.trim().length > 0
      ? row.email.trim()
      : null;
  const emailVerified = row?.email_verified === true;
  const subscriptionPlan = parseSubscriptionPlan(row?.subscription_plan);
  const brandColor = normalizeBrandColor(row?.brand_color);
  const themeMode: "dark" | "light" =
    row?.theme_mode === "light" ? "light" : "dark";
  // Default true when the column comes back null/missing (pre-migration
  // safety; column has NOT NULL DEFAULT true in 20260511100000).
  const walkinAutoAssign =
    row?.walkin_auto_assign === false ? false : true;
  const queueDisplayMode: "simple" | "full" =
    row?.queue_display_mode === "simple" ? "simple" : "full";
  const phoneOtpEnabled = row?.phone_otp_enabled === true;
  // Reminder aggregate state — defaults ON for new salons (seeded at registration).
  const remindersEnabled = row?.reminders_enabled === true;
  const reminder24hEnabled = row?.reminder_24h_enabled !== false;
  const reminder3hEnabled = row?.reminder_3h_enabled !== false;
  const smsRemindersEnabled = row?.sms_reminders_enabled === true;
  const googleReviewUrl =
    typeof row?.google_review_url === "string" && row.google_review_url.trim().length > 0
      ? row.google_review_url.trim()
      : null;
  const voiceAiEnabled = row?.voice_ai_enabled === true;
  const voiceAiPersonaName =
    typeof row?.voice_ai_persona_name === "string" && row.voice_ai_persona_name.trim().length > 0
      ? row.voice_ai_persona_name.trim()
      : "Lily";
  const bookingVerificationMode =
    typeof row?.booking_verification_mode === "string"
      ? row.booking_verification_mode
      : undefined;

  const domainInfo = await getSalonDomain(slug);

  return (
    <SalonSettingsHub
      slug={slug}
      dashboardModules={dashboardModules}
      dashboardPreset={dashboardPreset}
      canEditDashboardModules={canEditDashboardModules}
      salonEmail={salonEmail}
      emailVerified={emailVerified}
      subscriptionPlan={subscriptionPlan}
      brandColor={brandColor}
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
      voiceAiEnabled={voiceAiEnabled}
      voiceAiPersonaName={voiceAiPersonaName}
      domainInfo={domainInfo}
    />
  );
}
