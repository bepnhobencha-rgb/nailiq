"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { Toggle } from "@/components/ui/Toggle";
import {
  updateRemindersEnabled,
  updateReminderSettings,
} from "@/shared/noshow/noShowDashboardActions";
import { AuditLogViewer } from "@/components/dashboard/AuditLogViewer";
import { DashboardModulesSettings } from "@/components/dashboard/DashboardModulesSettings";
import { DashboardPresetSettings } from "@/components/dashboard/DashboardPresetSettings";
import { BrandColorSettings } from "@/components/dashboard/BrandColorSettings";
import { WalkinAutoAssignSettings } from "@/components/dashboard/WalkinAutoAssignSettings";
import { QueueDisplayModeSettings } from "@/components/dashboard/QueueDisplayModeSettings";
import { PhoneOtpSettings } from "@/components/dashboard/PhoneOtpSettings";
import { BookingVerificationSettings } from "@/components/dashboard/BookingVerificationSettings";
import { PricingPanel } from "@/components/dashboard/PricingPanel";
import { GoogleReviewSettings } from "@/components/dashboard/GoogleReviewSettings";
import { WixIntegrationSettings } from "@/components/dashboard/WixIntegrationSettings";
import { VoiceAiSettings } from "@/components/dashboard/VoiceAiSettings";
import { BusinessTypeSettings } from "@/components/dashboard/BusinessTypeSettings";
import { DomainSettings } from "@/components/dashboard/DomainSettings";
import type { SalonDomainInfo } from "@/shared/dashboard/domainActions";
import { LookPresetPicker } from "@/components/dashboard/LookPresetPicker";
import type { LookPreset } from "@/shared/verticals/lookPresets";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { MobileStack } from "@/components/layout/MobileStack";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { Badge } from "@/components/ui/Badge";
import { GearIcon } from "@/components/ui/icons/GearIcon";
import type { DashboardModulesConfig } from "@/shared/dashboard/dashboardModules";
import type { PresetKey } from "@/shared/dashboard/dashboardPresets";
import { getUserMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import type { SubscriptionPlan } from "@/shared/lib/subscriptionPlans";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function SalonSettingsHub({
  slug,
  dashboardModules,
  dashboardPreset,
  canEditDashboardModules,
  salonEmail,
  emailVerified,
  subscriptionPlan,
  brandColor,
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
  voiceAiEnabled,
  voiceAiPersonaName,
  vertical,
  domainInfo,
  lookPresets,
}: {
  slug: string;
  dashboardModules: DashboardModulesConfig;
  dashboardPreset: PresetKey;
  canEditDashboardModules: boolean;
  salonEmail: string | null;
  emailVerified: boolean;
  subscriptionPlan: SubscriptionPlan;
  brandColor: string;
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
  voiceAiEnabled: boolean;
  voiceAiPersonaName: string;
  vertical: string;
  domainInfo: SalonDomainInfo;
  lookPresets: LookPreset[];
}) {
  const searchParams = useSearchParams();
  const verified = searchParams?.get("verified") === "1";
  const verifyError = searchParams?.get("verify_error");
  const upgraded = searchParams?.get("upgraded") === "1";
  // Power-user mode: ?advanced=true shows DashboardModules, Preset, AuditLog
  const advancedMode = searchParams?.get("advanced") === "true";

  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Reminder toggle state
  const [reminderOn, setReminderOn] = useState(remindersEnabled);
  const [adv24h, setAdv24h] = useState(reminder24hEnabled);
  const [adv3h, setAdv3h] = useState(reminder3hEnabled);
  const [advSms, setAdvSms] = useState(smsRemindersEnabled);
  const [reminderAdvOpen, setReminderAdvOpen] = useState(false);
  const [reminderPending, startReminderTransition] = useTransition();
  const [advSaved, setAdvSaved] = useState(false);

  function handleReminderToggle(next: boolean) {
    setReminderOn(next);
    if (next) {
      setAdv24h(true);
      setAdv3h(true);
      setAdvSms(true);
    }
    startReminderTransition(async () => {
      if (next) {
        await updateRemindersEnabled(slug, true);
        await updateReminderSettings(slug, {
          reminder_24h_enabled: true,
          reminder_3h_enabled: true,
          sms_reminders_enabled: true,
        });
      } else {
        await updateRemindersEnabled(slug, false);
      }
    });
  }

  function handleReminderAdvSave() {
    startReminderTransition(async () => {
      await updateReminderSettings(slug, {
        reminder_24h_enabled: adv24h,
        reminder_3h_enabled: adv3h,
        sms_reminders_enabled: advSms,
      });
      setAdvSaved(true);
      setTimeout(() => setAdvSaved(false), 2500);
    });
  }

  const { language } = useUserLanguage();
  const messages = getUserMessages(language);
  const t = messages.salonSettings;
  const base = `/dashboard/${encodeURIComponent(slug)}/setup`;

  const rows: { href: string; label: string }[] = [
    { href: `${base}/services`, label: t.sectionServices },
    { href: `${base}/staff`, label: t.sectionStaff },
    { href: `${base}/hours`, label: t.sectionHours },
    { href: `${base}/address`, label: t.sectionAddress },
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
                <span className="shrink-0 text-nq-muted" aria-hidden>→</span>
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
          <span className="shrink-0" aria-hidden>→</span>
        </Link>

        {/* ── Email verification ──────────────────────────────── */}
        <section
          data-testid="settings-email-verification"
          className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-3"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
            {t.emailVerification.sectionTitle}
          </p>
          {verified ? (
            <p
              role="status"
              data-testid="settings-email-verified-toast"
              className="mt-2 rounded-md border border-nq-success/40 bg-nq-success/10 px-3 py-2 text-sm text-nq-success"
            >
              {t.emailVerification.verifiedToast}
            </p>
          ) : null}
          {verifyError ? (
            <p
              role="alert"
              data-testid="settings-email-verify-error"
              className="mt-2 rounded-md border border-nq-error/40 bg-nq-error/10 px-3 py-2 text-sm text-nq-error"
            >
              {t.emailVerification.verifyErrorPrefix}
              {verifyError}
            </p>
          ) : null}
          {salonEmail ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="break-all text-sm text-nq-foreground">{salonEmail}</span>
              {emailVerified ? (
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
              )}
            </div>
          ) : (
            <p className="mt-2 text-sm text-nq-muted">{t.emailVerification.noEmailHint}</p>
          )}
          {salonEmail && !emailVerified ? (
            <p className="mt-1 text-xs text-nq-muted">{t.emailVerification.pendingHint}</p>
          ) : null}
        </section>

        <p className="mt-3 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-3 text-sm leading-relaxed text-nq-muted">
          {t.hintRecoveryEmail}
        </p>

        {/* ── Reminder toggle ─────────────────────────────────── */}
        {canEditDashboardModules ? (
          <section
            data-testid="settings-reminder-toggle"
            className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-nq-foreground">{t.reminders.autoTitle}</p>
                <p className="mt-0.5 text-xs text-nq-muted">{t.reminders.autoHint}</p>
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
              <span aria-hidden className="text-[10px]">{reminderAdvOpen ? "▲" : "▼"}</span>
            </button>

            {reminderAdvOpen && (
              <div className="mt-3 flex flex-col gap-3 border-t border-nq-border/20 pt-3">
                {(
                  [
                    { key: "24h", label: t.reminders.email24h, checked: adv24h, set: setAdv24h },
                    { key: "3h",  label: t.reminders.email3h,  checked: adv3h,  set: setAdv3h },
                    { key: "sms", label: t.reminders.sms3h,    checked: advSms, set: setAdvSms },
                  ] as const
                ).map(({ key, label, checked, set }) => (
                  <label
                    key={key}
                    className="flex cursor-pointer items-center gap-3 text-sm text-nq-foreground"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-nq-border/60 text-nq-primary focus:ring-nq-primary/40"
                      checked={checked}
                      disabled={reminderPending}
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
                    <span className="text-xs text-nq-success">{t.reminders.saved}</span>
                  ) : null}
                </div>
              </div>
            )}
          </section>
        ) : null}

        {/* ── Business type (vertical) ────────────────────────── */}
        {canEditDashboardModules ? (
          <BusinessTypeSettings slug={slug} initialVertical={vertical} />
        ) : null}

        {/* ── Booking page style (look presets) ───────────────── */}
        {canEditDashboardModules ? (
          <LookPresetPicker
            slug={slug}
            presets={lookPresets}
            currentBrandColor={brandColor}
            currentThemeMode={themeMode}
          />
        ) : null}

        {/* ── Custom domain ───────────────────────────────────── */}
        {canEditDashboardModules ? (
          <DomainSettings slug={slug} initial={domainInfo} />
        ) : null}

        {/* ── Google Review URL ───────────────────────────────── */}
        {canEditDashboardModules ? (
          <GoogleReviewSettings
            slug={slug}
            initialValue={googleReviewUrl ?? ""}
          />
        ) : null}

        {/* ── Wix integration (self-service connect) ──────────── */}
        {canEditDashboardModules ? <WixIntegrationSettings slug={slug} /> : null}

        {/* ── Voice AI persona name (chỉ hiện khi voice AI được bật) ── */}
        {canEditDashboardModules && voiceAiEnabled ? (
          <VoiceAiSettings
            slug={slug}
            initialName={voiceAiPersonaName}
          />
        ) : null}

        {/* ── Pricing ─────────────────────────────────────────── */}
        {canEditDashboardModules ? (
          <PricingPanel
            slug={slug}
            currentPlan={subscriptionPlan}
            messages={messages.receptionist.pricing}
          />
        ) : null}

        {/* ── Advanced settings (collapsible) ─────────────────── */}
        {canEditDashboardModules ? (
          <section className="mt-4">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center justify-between rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-3 text-sm font-medium text-nq-muted transition-colors hover:border-nq-border/50 hover:text-nq-foreground"
              aria-expanded={advancedOpen}
            >
              <span>Advanced settings</span>
              <span aria-hidden className="text-xs">{advancedOpen ? "▲" : "▼"}</span>
            </button>

            {advancedOpen && (
              <div className="mt-3 flex flex-col gap-3">
                <BrandColorSettings
                  slug={slug}
                  initialValue={brandColor}
                  initialThemeMode={themeMode}
                />
                <WalkinAutoAssignSettings
                  slug={slug}
                  initialValue={walkinAutoAssign}
                  canEdit={canEditDashboardModules}
                />
                <QueueDisplayModeSettings
                  slug={slug}
                  initialValue={queueDisplayMode}
                  canEdit={canEditDashboardModules}
                />
                <PhoneOtpSettings
                  slug={slug}
                  initialValue={phoneOtpEnabled}
                  canEdit={canEditDashboardModules}
                />
                <BookingVerificationSettings
                  slug={slug}
                  initialMode={(bookingVerificationMode as "never" | "auto" | "always_otp" | "always_deposit" | "deposit_first") ?? "never"}
                  canEdit={canEditDashboardModules}
                  plan={subscriptionPlan as "free" | "pro" | "studio" | "enterprise"}
                />
              </div>
            )}
          </section>
        ) : null}

        {/* ── Power-user panels (only visible at ?advanced=true) ── */}
        {advancedMode && canEditDashboardModules ? (
          <>
            <DashboardModulesSettings
              slug={slug}
              initialModules={dashboardModules}
              canEdit={canEditDashboardModules}
            />
            <DashboardPresetSettings
              slug={slug}
              initialPreset={dashboardPreset}
              canEdit={canEditDashboardModules}
            />
            <AuditLogViewer
              slug={slug}
              messages={messages.receptionist.auditLog}
            />
          </>
        ) : null}
      </MobileStack>
    </ResponsiveShell>
  );
}
