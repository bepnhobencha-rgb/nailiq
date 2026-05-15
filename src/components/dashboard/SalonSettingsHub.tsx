"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AuditLogViewer } from "@/components/dashboard/AuditLogViewer";
import { DashboardModulesSettings } from "@/components/dashboard/DashboardModulesSettings";
import { DashboardPresetSettings } from "@/components/dashboard/DashboardPresetSettings";
import { BrandColorSettings } from "@/components/dashboard/BrandColorSettings";
import { WalkinAutoAssignSettings } from "@/components/dashboard/WalkinAutoAssignSettings";
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
}: {
  slug: string;
  dashboardModules: DashboardModulesConfig;
  dashboardPreset: PresetKey;
  canEditDashboardModules: boolean;
  /** `salons.email` — null when no recovery email is on file. */
  salonEmail: string | null;
  /** `salons.email_verified` — `true` only after the verify link is clicked. */
  emailVerified: boolean;
  /** `salons.subscription_plan` — drives the Pricing panel and the
   *  top-bar plan Badge. */
  subscriptionPlan: SubscriptionPlan;
  /** `salons.brand_color` — drives the booking page primary color (PR #109). */
  brandColor: string;
  /** `salons.theme_mode` — drives the booking page light/dark surface
   *  set. Dashboard itself is unaffected. */
  themeMode: "dark" | "light";
  /** `salons.walkin_auto_assign` — drives whether the receptionist's
   *  "Assign immediately" path is offered (PR #107). */
  walkinAutoAssign: boolean;
}) {
  const searchParams = useSearchParams();
  const verified = searchParams?.get("verified") === "1";
  const verifyError = searchParams?.get("verify_error");
  const upgraded = searchParams?.get("upgraded") === "1";
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
        {/* Plan badge in the top strip — Pro / Premium owners see a
            VIP-styled chip so the paid status is obvious at a glance.
            Free plan shows nothing (no decoration for the default). */}
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

        {/* Recovery email + verification status. The salon's email is
            edited via the dashboard banner (existing flow); this block
            displays it + the verified/pending Badge so owners can
            confirm the verification link landed. Pair color with text
            label per COLOR_TOKENS §5. */}
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
              <span className="break-all text-sm text-nq-foreground">
                {salonEmail}
              </span>
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
            <p className="mt-2 text-sm text-nq-muted">
              {t.emailVerification.noEmailHint}
            </p>
          )}
          {salonEmail && !emailVerified ? (
            <p className="mt-1 text-xs text-nq-muted">
              {t.emailVerification.pendingHint}
            </p>
          ) : null}
        </section>

        <p className="mt-3 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-3 text-sm leading-relaxed text-nq-muted">
          {t.hintRecoveryEmail}
        </p>

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

        {/* Pricing — owner-only. The server actions also gate on
            `role === 'owner'`, so this is defense-in-depth. */}
        {canEditDashboardModules ? (
          <PricingPanel
            slug={slug}
            currentPlan={subscriptionPlan}
            messages={messages.receptionist.pricing}
          />
        ) : null}

        {/* Audit log — owner-only. The viewer's server action also gates
            on `role === 'owner'`, so this is defense-in-depth. */}
        {canEditDashboardModules ? (
          <AuditLogViewer
            slug={slug}
            messages={messages.receptionist.auditLog}
          />
        ) : null}
      </MobileStack>
    </ResponsiveShell>
  );
}
