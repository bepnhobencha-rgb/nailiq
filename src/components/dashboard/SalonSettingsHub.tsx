"use client";

import Link from "next/link";
import { DashboardModulesSettings } from "@/components/dashboard/DashboardModulesSettings";
import { DashboardPresetSettings } from "@/components/dashboard/DashboardPresetSettings";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { MobileStack } from "@/components/layout/MobileStack";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { GearIcon } from "@/components/ui/icons/GearIcon";
import type { DashboardModulesConfig } from "@/shared/dashboard/dashboardModules";
import type { PresetKey } from "@/shared/dashboard/dashboardPresets";
import { getUserMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function SalonSettingsHub({
  slug,
  dashboardModules,
  dashboardPreset,
  canEditDashboardModules,
}: {
  slug: string;
  dashboardModules: DashboardModulesConfig;
  dashboardPreset: PresetKey;
  canEditDashboardModules: boolean;
}) {
  const { language } = useUserLanguage();
  const t = getUserMessages(language).salonSettings;
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

        <p className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-3 text-sm leading-relaxed text-nq-muted">
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
      </MobileStack>
    </ResponsiveShell>
  );
}
