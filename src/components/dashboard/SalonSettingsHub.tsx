"use client";

import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuditLogViewer } from "@/components/dashboard/AuditLogViewer";
import { DashboardModulesSettings } from "@/components/dashboard/DashboardModulesSettings";
import { DashboardPresetSettings } from "@/components/dashboard/DashboardPresetSettings";
import { BrandColorSettings } from "@/components/dashboard/BrandColorSettings";
import { WalkinAutoAssignSettings } from "@/components/dashboard/WalkinAutoAssignSettings";
import { PhoneOtpSettings } from "@/components/dashboard/PhoneOtpSettings";
import { PricingPanel } from "@/components/dashboard/PricingPanel";
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
  phoneOtpEnabled,
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
  phoneOtpEnabled: boolean;
}) {
  const searchParams = useSearchParams();
  const verified = searchParams?.get("verified") === "1";
  const verifyError = searchParams?.get("verify_error");
  const upgraded = searchParams?.get("upgraded") === "1";
  // Power-user mode: ?advanced=true shows DashboardModules, Preset, AuditLog
  const advancedMode = searchParams?.get("advanced") === "true";

  const [advancedOpen, setAdvancedOpen] = useState(false);

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
                <PhoneOtpSettings
                  slug={slug}
                  initialValue={phoneOtpEnabled}
                  canEdit={canEditDashboardModules}
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
