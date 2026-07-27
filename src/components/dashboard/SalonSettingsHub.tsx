"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Toggle } from "@/components/ui/Toggle";
import {
  updateRemindersEnabled,
  updateReminderSettings,
} from "@/shared/noshow/noShowDashboardActions";
import { addSalonEmail, resendVerification } from "@/shared/dashboard/addEmailAction";
import { AuditLogViewer } from "@/components/dashboard/AuditLogViewer";
import { DashboardModulesSettings } from "@/components/dashboard/DashboardModulesSettings";
import { DashboardPresetSettings } from "@/components/dashboard/DashboardPresetSettings";
import { BrandColorSettings } from "@/components/dashboard/BrandColorSettings";
import { SalonLogoSettings } from "@/components/dashboard/SalonLogoSettings";
import { WalkinAutoAssignSettings } from "@/components/dashboard/WalkinAutoAssignSettings";
import { QueueDisplayModeSettings } from "@/components/dashboard/QueueDisplayModeSettings";
import { PhoneOtpSettings } from "@/components/dashboard/PhoneOtpSettings";
import { BookingVerificationSettings } from "@/components/dashboard/BookingVerificationSettings";
import { PricingPanel } from "@/components/dashboard/PricingPanel";
import { GoogleReviewSettings } from "@/components/dashboard/GoogleReviewSettings";
import { WixIntegrationSettings } from "@/components/dashboard/WixIntegrationSettings";
import { ResourceSettings } from "@/components/dashboard/ResourceSettings";
import { StaffShiftHub } from "@/components/dashboard/StaffShiftHub";
import { VoiceAiSettings } from "@/components/dashboard/VoiceAiSettings";
import { BusinessTypeSettings } from "@/components/dashboard/BusinessTypeSettings";
import { DomainSettings } from "@/components/dashboard/DomainSettings";
import type { SalonDomainInfo } from "@/shared/dashboard/domainActions";
import { LookPresetPicker } from "@/components/dashboard/LookPresetPicker";
import type { LookPreset } from "@/shared/verticals/lookPresets";
import { StaffSelectionSettings } from "@/components/dashboard/StaffSelectionSettings";
import { BookingLeadSettings } from "@/components/dashboard/BookingLeadSettings";
import { GroupTogetherSettings } from "@/components/dashboard/GroupTogetherSettings";
import { ReferenceImageSettings } from "@/components/dashboard/ReferenceImageSettings";
import { AutoNoShowSettings } from "@/components/dashboard/AutoNoShowSettings";
import { ClientSegmentSettings } from "@/components/dashboard/ClientSegmentSettings";
import { WinBackSettings } from "@/components/dashboard/WinBackSettings";
import { TaxSettingsHub } from "@/components/dashboard/TaxSettingsHub";
import { GroupBookingHub } from "@/components/dashboard/GroupBookingHub";
import { AiManagerHub } from "@/components/dashboard/AiManagerHub";
import type { AiAgentFlags } from "@/shared/dashboard/aiAgentTypes";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { MobileStack } from "@/components/layout/MobileStack";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import {
  SettingsCategory,
  SettingsJumpBar,
} from "@/components/dashboard/SettingsCategory";
import { Badge } from "@/components/ui/Badge";
import { GearIcon } from "@/components/ui/icons/GearIcon";
import type { DashboardModulesConfig } from "@/shared/dashboard/dashboardModules";
import type { PresetKey } from "@/shared/dashboard/dashboardPresets";
import { getUserMessages } from "@/shared/i18n/user";
import { OwnerNotificationCard } from "@/components/dashboard/OwnerNotificationCard";
import { StaffNotificationCard } from "@/components/dashboard/StaffNotificationCard";
import { CustomerChannelCard } from "@/components/dashboard/CustomerChannelCard";
import { AIReportCard } from "@/components/dashboard/AIReportCard";
import { GooglePlaceIdCard } from "@/components/dashboard/GooglePlaceIdCard";
import { YelpBusinessIdCard } from "@/components/dashboard/YelpBusinessIdCard";
import { cn } from "@/shared/lib/cn";
import type { SubscriptionPlan } from "@/shared/lib/subscriptionPlans";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { MobileAccountCard } from "@/components/dashboard/MobileAccountCard";
import type { OwnerSalonSummary } from "@/shared/dashboard/salonOwnerActions";

export function SalonSettingsHub({
  slug,
  dashboardModules,
  dashboardPreset,
  canEditDashboardModules,
  canManageSalonSettings,
  salonEmail,
  emailVerified,
  subscriptionPlan,
  brandColor,
  logoUrl,
  themeMode,
  walkinAutoAssign,
  queueDisplayMode,
  phoneOtpEnabled,
  bookingVerificationMode,
  remindersEnabled,
  reminder24hEnabled,
  reminder3hEnabled,
  smsRemindersEnabled,
  googleReviewUrl,
  googlePlaceId,
  yelpBusinessId,
  voiceAiEnabled,
  voiceAiPersonaName,
  vertical,
  domainInfo,
  lookPresets,
  staffSelectionEnabled,
  bookingLeadMinutes,
  groupTogetherThresholdMin,
  referenceImageEnabled,
  autoNoShowMinutes,
  winBackEnabled,
  clientNewMaxVisits,
  clientAtRiskDays,
  aiFlags,
  aiManagerInstructions,
  ownerNotifChannel,
  ownerPhone,
  userEmail,
  role,
  salonName,
  salons,
  resourcesEnabled,
  primaryGridAxis,
  smsOutboundEnabled,
  emailOutboundEnabled,
}: {
  slug: string;
  dashboardModules: DashboardModulesConfig;
  dashboardPreset: PresetKey;
  canEditDashboardModules: boolean;
  /** owner OR admin — can view/edit all operational settings except Plan & module layout */
  canManageSalonSettings: boolean;
  salonEmail: string | null;
  emailVerified: boolean;
  subscriptionPlan: SubscriptionPlan;
  brandColor: string;
  logoUrl: string | null;
  themeMode: "dark" | "light";
  walkinAutoAssign: boolean;
  queueDisplayMode: "simple" | "full";
  phoneOtpEnabled: boolean;
  remindersEnabled: boolean;
  reminder24hEnabled: boolean;
  reminder3hEnabled: boolean;
  smsRemindersEnabled: boolean;
  bookingVerificationMode?: string;
  googleReviewUrl: string | null;
  googlePlaceId: string | null;
  yelpBusinessId: string | null;
  voiceAiEnabled: boolean;
  voiceAiPersonaName: string;
  vertical: string;
  domainInfo: SalonDomainInfo;
  lookPresets: LookPreset[];
  staffSelectionEnabled: boolean;
  bookingLeadMinutes: number;
  groupTogetherThresholdMin: number;
  referenceImageEnabled: boolean;
  autoNoShowMinutes: number;
  winBackEnabled: boolean;
  clientNewMaxVisits: number;
  clientAtRiskDays: number;
  aiFlags: AiAgentFlags;
  aiManagerInstructions?: string | null;
  ownerNotifChannel: "email" | "sms" | "both";
  ownerPhone: string | null;
  userEmail: string | null;
  role: string;
  salonName?: string;
  salons?: OwnerSalonSummary[];
  resourcesEnabled: boolean;
  primaryGridAxis: "staff" | "resource";
  /** Operator-level SMS kill-switch (default ON). */
  smsOutboundEnabled: boolean;
  /** Operator-level email kill-switch (default ON). */
  emailOutboundEnabled: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const verified = searchParams?.get("verified") === "1";
  const verifyError = searchParams?.get("verify_error");
  const upgraded = searchParams?.get("upgraded") === "1";
  // Power-user mode: ?advanced=true shows DashboardModules, Preset, AuditLog
  const advancedMode = searchParams?.get("advanced") === "true";

  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Notification email card state
  const [emailEditOpen, setEmailEditOpen] = useState(false);
  const [newEmailInput, setNewEmailInput] = useState(salonEmail ?? "");
  const [emailEditPending, startEmailEditTransition] = useTransition();
  const [emailEditError, setEmailEditError] = useState<string | null>(null);
  const [emailEditSuccess, setEmailEditSuccess] = useState(false);
  const [resendPending, startResendTransition] = useTransition();
  const [resendSent, setResendSent] = useState(false);

  // Reminder toggle state
  const [reminderOn, setReminderOn] = useState(remindersEnabled);
  const [adv24h, setAdv24h] = useState(reminder24hEnabled);
  const [adv3h, setAdv3h] = useState(reminder3hEnabled);
  const [advSms, setAdvSms] = useState(smsRemindersEnabled);
  const [reminderAdvOpen, setReminderAdvOpen] = useState(false);
  const [reminderPending, startReminderTransition] = useTransition();
  const [advSaved, setAdvSaved] = useState(false);

  function handleReminderToggle(next: boolean) {
    const nextSms = next && smsOutboundEnabled;
    setReminderOn(next);
    if (next) {
      setAdv24h(emailOutboundEnabled);
      setAdv3h(emailOutboundEnabled);
      setAdvSms(nextSms);
    }
    startReminderTransition(async () => {
      if (next) {
        await updateRemindersEnabled(slug, true);
        await updateReminderSettings(slug, {
          reminder_24h_enabled: emailOutboundEnabled,
          reminder_3h_enabled: emailOutboundEnabled,
          sms_reminders_enabled: nextSms,
        });
      } else {
        await updateRemindersEnabled(slug, false);
      }
    });
  }

  function handleReminderAdvSave() {
    startReminderTransition(async () => {
      await updateReminderSettings(slug, {
        reminder_24h_enabled: emailOutboundEnabled && adv24h,
        reminder_3h_enabled: emailOutboundEnabled && adv3h,
        sms_reminders_enabled: smsOutboundEnabled && advSms,
      });
      setAdvSaved(true);
      setTimeout(() => setAdvSaved(false), 2500);
    });
  }

  const { language } = useUserLanguage();
  const vi = language === "vi";
  const messages = getUserMessages(language);
  const t = messages.salonSettings;
  const base = `/dashboard/${encodeURIComponent(slug)}/setup`;

  const rows: { href: string; label: string }[] = [
    { href: `${base}/services`, label: t.sectionServices },
    { href: `${base}/staff`, label: t.sectionStaff },
    { href: `${base}/hours`, label: t.sectionHours },
    { href: `${base}/address`, label: t.sectionAddress },
    { href: `${base}/promotions`, label: t.sectionPromotions },
    { href: `${base}/manager-briefing`, label: t.sectionAiManager },
  ];

  const myPageHref = `/dashboard/${encodeURIComponent(slug)}/settings/my-page`;

  return (
    <ResponsiveShell>
      <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4 sm:pt-6">
        <SetupBackNav
          slug={slug}
          title={t.pageTitle}
          titleAccessory={<GearIcon className="h-8 w-8 sm:h-9 sm:w-9" />}
        />

        {subscriptionPlan !== "free" ? (
          <div className="mb-3">
            <Badge
              data-testid={`settings-plan-badge-${subscriptionPlan}`}
              variant="vip"
              state="default"
              size="sm"
            >
              {subscriptionPlan === "pro"
                ? messages.receptionist.pricing.planBadgePro
                : messages.receptionist.pricing.planBadgePremium}
            </Badge>
          </div>
        ) : null}

        {upgraded ? (
          <p
            role="status"
            data-testid="settings-upgraded-toast"
            className="mb-3 rounded-md border border-nq-success/40 bg-nq-success/10 px-3 py-2 text-sm text-nq-success"
          >
            {messages.receptionist.pricing.upgradedToast}
          </p>
        ) : null}

        <p className="mb-6 text-pretty text-base leading-relaxed text-nq-muted">
          {t.pageIntro}
        </p>

        {/* ── 4 setup page links ──────────────────────────────── */}
        <ul className="flex flex-col gap-2" aria-label={t.pageTitle}>
          {rows.map(({ href, label }) => (
            <li key={href}>
              <Link
                href={href}
                className={cn(
                  "flex min-h-[3.25rem] touch-manipulation items-center justify-between gap-4 rounded-2xl border border-nq-border/40 bg-nq-surface/45 px-4 py-3",
                  "text-base font-medium text-nq-foreground ring-1 ring-inset ring-nq-primary/10 transition-colors",
                  "hover:border-nq-primary/35 hover:bg-nq-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
                )}
              >
                <span>{label}</span>
                <span className="shrink-0 text-nq-muted" aria-hidden>
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>

        {/* ── My Page ─────────────────────────────────────────── */}
        <Link
          href={myPageHref}
          className="mt-2 flex min-h-[3.25rem] touch-manipulation items-center justify-between gap-4 rounded-2xl border border-[#d4af37]/30 bg-[#d4af37]/5 px-4 py-3 text-base font-medium text-[#d4af37] ring-1 ring-inset ring-[#d4af37]/10 transition-colors hover:border-[#d4af37]/50 hover:bg-[#d4af37]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4af37]/45"
        >
          <span>My Page</span>
          <span className="shrink-0" aria-hidden>
            →
          </span>
        </Link>

        {canManageSalonSettings && voiceAiEnabled ? (
          <Link
            data-testid="settings-voice-ai-link"
            href={`/dashboard/${encodeURIComponent(slug)}/setup/voice`}
            className="mt-2 flex min-h-[3.25rem] touch-manipulation items-center justify-between gap-4 rounded-2xl border border-nq-primary/35 bg-nq-primary/5 px-4 py-3 text-nq-primary ring-1 ring-inset ring-nq-primary/10 transition-colors hover:border-nq-primary/55 hover:bg-nq-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45"
          >
            <span className="min-w-0">
              <span className="block text-base font-semibold">AI Voice</span>
              <span className="mt-0.5 block text-xs text-nq-muted">
                {vi
                  ? "Giọng nói, upsell và số chuyển máy"
                  : "Voice, upsells, and human transfer phone"}
              </span>
            </span>
            <span className="shrink-0" aria-hidden>
              →
            </span>
          </Link>
        ) : null}

        {/* ── Jump bar — quick anchors to each category ───────── */}
        <SettingsJumpBar
          label={t.categories.jumpLabel}
          items={[
            { id: "cat-notifications", title: t.categories.notifications.title },
            ...(canManageSalonSettings
              ? [
                  { id: "cat-brand", title: t.categories.brand.title },
                  { id: "cat-booking", title: t.categories.booking.title },
                  { id: "cat-ai-manager", title: vi ? "AI Quản Lý" : "AI Manager" },
                  {
                    id: "cat-integrations",
                    title: t.categories.integrations.title,
                  },
                ]
              : []),
            ...(canManageSalonSettings
              ? [{ id: "cat-plan", title: t.categories.plan.title }]
              : []),
          ]}
        />

        {/* ══ Category: Notifications & reminders ══════════════ */}
        <SettingsCategory
          id="cat-notifications"
          title={t.categories.notifications.title}
          subtitle={t.categories.notifications.subtitle}
        >
        {/* ── Notification email card ──────────────────────────── */}
        <section
          data-testid="settings-email-verification"
          className={cn(
            "mt-6 overflow-hidden rounded-2xl border bg-nq-surface/35",
            emailVerified && salonEmail
              ? "border-nq-primary/30"
              : salonEmail
                ? "border-amber-500/30"
                : "border-nq-border/30",
          )}
        >
          {/* Top accent stripe */}
          <div
            className={cn(
              "h-0.5 w-full",
              emailVerified && salonEmail
                ? "bg-gradient-to-r from-nq-primary/60 to-transparent"
                : salonEmail
                  ? "bg-gradient-to-r from-amber-500/60 to-transparent"
                  : "bg-nq-border/40",
            )}
          />

          <div className="px-4 py-4 space-y-3">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-nq-foreground">
                  {t.emailVerification.sectionTitle}
                </p>
                <p className="mt-0.5 text-xs text-nq-muted">
                  {t.emailVerification.description}
                </p>
              </div>
              {salonEmail ? (
                emailVerified ? (
                  <Badge
                    data-testid="settings-email-verified-badge"
                    variant="success"
                    state="default"
                    size="sm"
                  >
                    {t.emailVerification.verifiedBadge}
                  </Badge>
                ) : (
                  <Badge
                    data-testid="settings-email-pending-badge"
                    variant="warning"
                    state="default"
                    size="sm"
                  >
                    {t.emailVerification.pendingBadge}
                  </Badge>
                )
              ) : null}
            </div>

            {/* Verified / error flash from URL params */}
            {verified ? (
              <p
                role="status"
                data-testid="settings-email-verified-toast"
                className="rounded-lg border border-nq-success/40 bg-nq-success/10 px-3 py-2 text-xs text-nq-success"
              >
                {t.emailVerification.verifiedToast}
              </p>
            ) : null}
            {verifyError ? (
              <p
                role="alert"
                data-testid="settings-email-verify-error"
                className="rounded-lg border border-nq-error/40 bg-nq-error/10 px-3 py-2 text-xs text-nq-error"
              >
                {t.emailVerification.verifyErrorPrefix}
                {verifyError}
              </p>
            ) : null}

            {/* Current email display */}
            {salonEmail ? (
              <p className="break-all font-mono text-sm text-nq-foreground">
                {salonEmail}
              </p>
            ) : (
              <p className="text-sm text-nq-muted/70">
                {t.emailVerification.noEmailHint}
              </p>
            )}

            {/* Pending hint */}
            {salonEmail && !emailVerified ? (
              <p className="text-xs text-nq-muted">
                {t.emailVerification.pendingHint}
              </p>
            ) : null}

            {/* Success / error from inline save */}
            {emailEditSuccess ? (
              <p className="rounded-lg border border-nq-success/40 bg-nq-success/10 px-3 py-2 text-xs text-nq-success">
                {t.emailVerification.saveSuccess}
              </p>
            ) : null}
            {resendSent ? (
              <p className="rounded-lg border border-nq-success/40 bg-nq-success/10 px-3 py-2 text-xs text-nq-success">
                {t.emailVerification.resendSent}
              </p>
            ) : null}
            {emailEditError ? (
              <p className="rounded-lg border border-nq-error/40 bg-nq-error/10 px-3 py-2 text-xs text-nq-error">
                {emailEditError}
              </p>
            ) : null}

            {/* Action buttons (owner/admin only) */}
            {canManageSalonSettings ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {/* Resend verification — only when pending */}
                {salonEmail && !emailVerified ? (
                  <button
                    type="button"
                    disabled={resendPending}
                    onClick={() => {
                      setResendSent(false);
                      startResendTransition(async () => {
                        await resendVerification(slug);
                        setResendSent(true);
                        setTimeout(() => setResendSent(false), 4000);
                      });
                    }}
                    className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-400 transition hover:bg-amber-500/15 disabled:opacity-50"
                  >
                    {resendPending ? "…" : t.emailVerification.resendButton}
                  </button>
                ) : null}

                {/* Change email toggle */}
                <button
                  type="button"
                  onClick={() => {
                    setEmailEditOpen((v) => !v);
                    setEmailEditError(null);
                    setEmailEditSuccess(false);
                    setNewEmailInput(salonEmail ?? "");
                  }}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-xs font-medium transition",
                    emailEditOpen
                      ? "border-nq-border bg-nq-border/20 text-nq-muted"
                      : "border-nq-border bg-nq-surface text-nq-foreground hover:border-nq-primary/40 hover:text-nq-primary",
                  )}
                >
                  {emailEditOpen
                    ? t.emailVerification.cancelButton
                    : t.emailVerification.changeButton}
                </button>
              </div>
            ) : null}

            {/* Inline edit form */}
            {emailEditOpen && canManageSalonSettings ? (
              <form
                className="flex flex-wrap items-center gap-2 border-t border-nq-border/20 pt-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  setEmailEditError(null);
                  setEmailEditSuccess(false);
                  const val = newEmailInput.trim();
                  if (!val || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
                    setEmailEditError(t.emailVerification.invalidEmail);
                    return;
                  }
                  startEmailEditTransition(async () => {
                    const res = await addSalonEmail(slug, val);
                    if (!res.ok) {
                      setEmailEditError(
                        res.error === "invalid_email"
                          ? t.emailVerification.invalidEmail
                          : t.emailVerification.saveError,
                      );
                      return;
                    }
                    setEmailEditSuccess(true);
                    setEmailEditOpen(false);
                    router.refresh();
                    setTimeout(() => setEmailEditSuccess(false), 5000);
                  });
                }}
              >
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={newEmailInput}
                  onChange={(e) => setNewEmailInput(e.target.value)}
                  className="h-9 flex-1 min-w-0 rounded-lg border border-nq-border bg-nq-bg px-3 text-sm text-nq-foreground placeholder:text-nq-muted/60 focus:outline-none focus:ring-2 focus:ring-nq-primary/40"
                />
                <button
                  type="submit"
                  disabled={emailEditPending}
                  className="h-9 rounded-lg border border-nq-primary/40 bg-nq-primary/10 px-4 text-xs font-semibold text-nq-primary transition hover:bg-nq-primary/15 disabled:opacity-50"
                >
                  {emailEditPending
                    ? t.emailVerification.saving
                    : t.emailVerification.saveButton}
                </button>
              </form>
            ) : null}
          </div>
        </section>

        {/* ── Reminder toggle ─────────────────────────────────── */}
        {canManageSalonSettings ? (
          <section
            data-testid="settings-reminder-toggle"
            className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-nq-foreground">
                  {t.reminders.autoTitle}
                </p>
                <p className="mt-0.5 text-xs text-nq-muted">
                  {!smsOutboundEnabled && emailOutboundEnabled
                    ? language === "vi"
                      ? "Chỉ gửi email — SMS đang tắt trong Kênh liên lạc với khách."
                      : "Email only — SMS is disabled in Customer communication."
                    : !emailOutboundEnabled && smsOutboundEnabled
                      ? language === "vi"
                        ? "Chỉ gửi SMS — email đang tắt trong Kênh liên lạc với khách."
                        : "SMS only — email is disabled in Customer communication."
                      : !emailOutboundEnabled && !smsOutboundEnabled
                        ? language === "vi"
                          ? "Chưa có kênh gửi nào được bật."
                          : "No delivery channel is currently enabled."
                        : t.reminders.autoHint}
                </p>
              </div>
              <Toggle
                checked={reminderOn}
                disabled={reminderPending}
                aria-label={t.reminders.autoTitle}
                onChange={handleReminderToggle}
              />
            </div>

            <button
              type="button"
              onClick={() => setReminderAdvOpen((v) => !v)}
              className="mt-3 flex items-center gap-1 text-xs text-nq-muted underline-offset-2 hover:text-nq-foreground hover:underline"
              aria-expanded={reminderAdvOpen}
            >
              {t.reminders.advancedToggle}
              <span aria-hidden className="text-[10px]">
                {reminderAdvOpen ? "▲" : "▼"}
              </span>
            </button>

            {reminderAdvOpen && (
              <div className="mt-3 flex flex-col gap-3 border-t border-nq-border/20 pt-3">
                {(
                  [
                    {
                      key: "24h",
                      label: t.reminders.email24h,
                      checked: emailOutboundEnabled && adv24h,
                      set: setAdv24h,
                      available: emailOutboundEnabled,
                    },
                    {
                      key: "3h",
                      label: t.reminders.email3h,
                      checked: emailOutboundEnabled && adv3h,
                      set: setAdv3h,
                      available: emailOutboundEnabled,
                    },
                    {
                      key: "sms",
                      label: t.reminders.sms3h,
                      checked: smsOutboundEnabled && advSms,
                      set: setAdvSms,
                      available: smsOutboundEnabled,
                    },
                  ] as const
                ).map(({ key, label, checked, set, available }) => (
                  <label
                    key={key}
                    className={cn(
                      "flex items-center gap-3 text-sm",
                      available
                        ? "cursor-pointer text-nq-foreground"
                        : "cursor-not-allowed text-nq-muted",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-nq-border/60 text-nq-primary focus:ring-nq-primary/40"
                      checked={checked}
                      disabled={reminderPending || !available}
                      onChange={(e) => set(e.target.checked)}
                    />
                    {label}
                  </label>
                ))}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={reminderPending}
                    onClick={handleReminderAdvSave}
                    className="rounded-xl border border-nq-primary/40 bg-nq-primary/10 px-3 py-1.5 text-xs font-semibold text-nq-primary transition hover:bg-nq-primary/15 disabled:opacity-50"
                  >
                    {reminderPending ? t.reminders.saving : t.reminders.save}
                  </button>
                  {advSaved ? (
                    <span className="text-xs text-nq-success">
                      {t.reminders.saved}
                    </span>
                  ) : null}
                </div>
              </div>
            )}
          </section>
        ) : null}

        {/* ── Customer channel (SMS / email / A2P status) ─────── */}
        {canManageSalonSettings ? (
          <CustomerChannelCard slug={slug} />
        ) : null}

        {/* ── Manager + staff notification cards ──────────────── */}
        {canManageSalonSettings ? (
          <OwnerNotificationCard slug={slug} />
        ) : null}
        {canManageSalonSettings ? (
          <StaffNotificationCard
            slug={slug}
            smsOutboundEnabled={smsOutboundEnabled}
            emailOutboundEnabled={emailOutboundEnabled}
          />
        ) : null}
        {canManageSalonSettings ? (
          <AIReportCard slug={slug} />
        ) : null}
        </SettingsCategory>

        {/* ══ Category: Brand & booking page ═══════════════════ */}
        {canManageSalonSettings ? (
        <SettingsCategory
          id="cat-brand"
          title={t.categories.brand.title}
          subtitle={t.categories.brand.subtitle}
        >
          {/* ── Business type (vertical) ──────────────────────── */}
          <BusinessTypeSettings slug={slug} initialVertical={vertical} />
          {/* ── Booking page style (look presets) ─────────────── */}
          <LookPresetPicker
            slug={slug}
            presets={lookPresets}
            currentBrandColor={brandColor}
            currentThemeMode={themeMode}
          />
        </SettingsCategory>
        ) : null}

        {/* ══ Category: Booking & queue ════════════════════════ */}
        {canManageSalonSettings ? (
        <SettingsCategory
          id="cat-booking"
          title={t.categories.booking.title}
          subtitle={t.categories.booking.subtitle}
        >
        {/* ── Let customers choose a provider ─────────────────── */}
        {canManageSalonSettings ? (
          <StaffSelectionSettings
            slug={slug}
            initialEnabled={staffSelectionEnabled}
          />
        ) : null}

        {/* ── Minimum advance notice (booking lead time) ──────── */}
        {canManageSalonSettings ? (
          <BookingLeadSettings
            slug={slug}
            initialMinutes={bookingLeadMinutes}
          />
        ) : null}

        {/* ── Group booking "togetherness" threshold ──────────── */}
        {canEditDashboardModules ? (
          <GroupTogetherSettings
            slug={slug}
            initialMinutes={groupTogetherThresholdMin}
          />
        ) : null}

        {/* ── Reference-image upload toggle ───────────────────── */}
        {canManageSalonSettings ? (
          <ReferenceImageSettings
            slug={slug}
            initialEnabled={referenceImageEnabled}
          />
        ) : null}

        {/* ── Auto no-show (opt-in) ───────────────────────────── */}
        {canManageSalonSettings ? (
          <AutoNoShowSettings slug={slug} initialMinutes={autoNoShowMinutes} />
        ) : null}

        {/* ── Client lifecycle segment thresholds ─────────────── */}
        {canManageSalonSettings ? (
          <ClientSegmentSettings
            slug={slug}
            initialNewMaxVisits={clientNewMaxVisits}
            initialAtRiskDays={clientAtRiskDays}
          />
        ) : null}

        {/* ── Win-back email after no-show ────────────────────── */}
        {canManageSalonSettings ? (
          <WinBackSettings slug={slug} initialEnabled={winBackEnabled} />
        ) : null}

        {/* ── Tax on services ─────────────────────────────────── */}
        {canManageSalonSettings ? (
          <section className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-nq-muted">Tax</p>
            <TaxSettingsHub slug={slug} />
          </section>
        ) : null}

        {/* ── Group booking cutoff ─────────────────────────────── */}
        {canManageSalonSettings ? (
          <section className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-nq-muted">
              Đặt lịch nhóm
            </p>
            <GroupBookingHub slug={slug} />
          </section>
        ) : null}
        </SettingsCategory>
        ) : null}

        {/* ══ Category: AI Manager ═════════════════════════════ */}
        {canManageSalonSettings ? (
        <SettingsCategory
          id="cat-ai-manager"
          title={vi ? "AI Quản Lý" : "AI Manager"}
          subtitle={vi ? "Bật/tắt từng agent AI cho tiệm" : "Toggle AI agents for your salon"}
          defaultOpen={false}
        >
          <section
            data-testid="settings-nail-tryon-card"
            className="mb-6 rounded-2xl border border-nq-primary/30 bg-nq-primary/5 px-4 py-4"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-nq-foreground">
                  {vi ? "Nail Try-On & Smart Quote" : "Nail Try-On & Smart Quote"}
                </p>
                <p className="mt-1 max-w-2xl text-xs leading-5 text-nq-muted">
                  {vi
                    ? "Quản lý mẫu nail và liên kết từng mẫu với dịch vụ, add-on, thời lượng và giá của tiệm."
                    : "Manage nail designs and connect each look to the salon's service, add-on, duration, and price."}
                </p>
              </div>
              <Link
                href={`/dashboard/${encodeURIComponent(slug)}/setup/nail-tryon`}
                className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full bg-nq-primary px-5 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/50"
              >
                {vi ? "Mở Nail Try-On" : "Open Nail Try-On"}
              </Link>
            </div>
          </section>
          <AiManagerHub slug={slug} initialFlags={aiFlags} initialInstructions={aiManagerInstructions} initialNotifChannel={ownerNotifChannel} initialOwnerPhone={ownerPhone ?? ""} />
        </SettingsCategory>
        ) : null}

        {/* ══ Category: Integrations ═══════════════════════════ */}
        {canManageSalonSettings ? (
        <SettingsCategory
          id="cat-integrations"
          title={t.categories.integrations.title}
          subtitle={t.categories.integrations.subtitle}
          defaultOpen={false}
        >
        {/* ── Custom domain ───────────────────────────────────── */}
        {canManageSalonSettings ? (
          <DomainSettings slug={slug} initial={domainInfo} />
        ) : null}

        {/* ── Google Review URL ───────────────────────────────── */}
        {canManageSalonSettings ? (
          <GoogleReviewSettings
            slug={slug}
            initialValue={googleReviewUrl ?? ""}
          />
        ) : null}

        {/* ── AI Review Responder — Google Place ID ───────────── */}
        {canManageSalonSettings ? (
          <GooglePlaceIdCard
            slug={slug}
            initialPlaceId={googlePlaceId}
          />
        ) : null}

        {/* ── AI Yelp Review Responder — Yelp Business ID ─────── */}
        {canManageSalonSettings ? (
          <YelpBusinessIdCard
            slug={slug}
            initialYelpId={yelpBusinessId}
          />
        ) : null}

        {/* ── Resource layer (beds/chairs/stations) ────────────── */}
        {canEditDashboardModules ? (
          <ResourceSettings
            slug={slug}
            initialEnabled={resourcesEnabled}
            initialAxis={primaryGridAxis}
            vertical={vertical}
          />
        ) : null}

        {/* ── Staff shifts (weekly schedule) ──────────────────── */}
        {canEditDashboardModules ? (
          <section className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4">
            <h3 className="mb-1 text-sm font-semibold text-nq-foreground">Staff Shifts</h3>
            <StaffShiftHub slug={slug} />
          </section>
        ) : null}

        {/* ── Wix integration (self-service connect) ──────────── */}
        {canManageSalonSettings ? (
          <WixIntegrationSettings slug={slug} />
        ) : null}

        {/* ── Voice AI persona name (chỉ hiện khi voice AI được bật) ── */}
        {canManageSalonSettings && voiceAiEnabled ? (
          <VoiceAiSettings slug={slug} initialName={voiceAiPersonaName} />
        ) : null}
        </SettingsCategory>
        ) : null}

        {/* ══ Category: Plan & advanced ════════════════════════ */}
        {canManageSalonSettings ? (
        <SettingsCategory
          id="cat-plan"
          title={t.categories.plan.title}
          subtitle={t.categories.plan.subtitle}
          defaultOpen={false}
        >
        {/* ── Subscription plan (owner-only: billing) ─────────── */}
        {canEditDashboardModules ? (
          <PricingPanel
            slug={slug}
            currentPlan={subscriptionPlan}
            messages={messages.receptionist.pricing}
          />
        ) : null}

        {/* ── Advanced settings (collapsible) ─────────────────── */}
        {canManageSalonSettings ? (
          <section className="mt-4">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center justify-between rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-3 text-sm font-medium text-nq-muted transition-colors hover:border-nq-border/50 hover:text-nq-foreground"
              aria-expanded={advancedOpen}
            >
              <span>Advanced settings</span>
              <span aria-hidden className="text-xs">
                {advancedOpen ? "▲" : "▼"}
              </span>
            </button>

            {advancedOpen && (
              <div className="mt-3 flex flex-col gap-3">
                <SalonLogoSettings slug={slug} initialLogoUrl={logoUrl} />
                <BrandColorSettings
                  slug={slug}
                  initialValue={brandColor}
                  initialThemeMode={themeMode}
                />
                <WalkinAutoAssignSettings
                  slug={slug}
                  initialValue={walkinAutoAssign}
                  canEdit={canManageSalonSettings}
                />
                <QueueDisplayModeSettings
                  slug={slug}
                  initialValue={queueDisplayMode}
                  canEdit={canManageSalonSettings}
                />
                <PhoneOtpSettings
                  slug={slug}
                  initialValue={phoneOtpEnabled}
                  canEdit={canManageSalonSettings}
                />
                <BookingVerificationSettings
                  slug={slug}
                  initialMode={
                    (bookingVerificationMode as
                      | "never"
                      | "auto"
                      | "always_otp"
                      | "always_deposit"
                      | "deposit_first") ?? "never"
                  }
                  canEdit={canManageSalonSettings}
                  plan={
                    subscriptionPlan as "free" | "pro" | "studio" | "enterprise"
                  }
                />
              </div>
            )}
          </section>
        ) : null}

        {/* ── Power-user panels (only visible at ?advanced=true) ── */}
        {advancedMode && canManageSalonSettings ? (
          <>
            <DashboardModulesSettings
              slug={slug}
              initialModules={dashboardModules}
              canEdit={canManageSalonSettings}
            />
            <DashboardPresetSettings
              slug={slug}
              initialPreset={dashboardPreset}
              canEdit={canManageSalonSettings}
            />
            <AuditLogViewer
              slug={slug}
              messages={messages.receptionist.auditLog}
            />
          </>
        ) : null}
        </SettingsCategory>
        ) : null}

        {/* ══ Mobile-only: Account / Sign out ══════════════════
            Desktop users reach Sign Out via the sidebar account menu.
            This section is hidden on md+ screens. ══════════════ */}
        <MobileAccountCard
          userEmail={userEmail}
          role={role}
          slug={slug}
          salonName={salonName}
          salons={salons}
        />
      </MobileStack>
    </ResponsiveShell>
  );
}
