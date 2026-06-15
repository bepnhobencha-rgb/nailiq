"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import {
  Activity,
  Clock,
  LayoutGrid,
  Settings as SettingsIcon,
  TrendingUp,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { type ReleaseFeatureMap } from "@/components/layout/DashboardSidebar";
import { cn } from "@/shared/lib/cn";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import type { ReleaseFeatureKey } from "@/shared/features/featureRegistry";

type Props = {
  slug: string;
  walkinQueueCount?: number;
  /** Salon-member role — gates the owner/admin-only Pulse tab. */
  role?: string;
  /** Release-feature visibility (PR2). Beta tabs hide when their key is
   *  not explicitly true — mirrors DashboardSidebar. See `featureRegistry`. */
  releaseFeatures?: ReleaseFeatureMap;
};

/**
 * Mobile (<md) primary nav. 5 fixed tabs per
 * `docs/DASHBOARD_LAYOUT_RULES.md` §9.6. Hidden on `md`+ where
 * DashboardSidebar takes over.
 */
export function MobileBottomNav({
  slug,
  walkinQueueCount = 0,
  role,
  releaseFeatures = {},
}: Props) {
  const pathname = usePathname() ?? "";
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).nav, [language]);

  const slugSeg = encodeURIComponent(slug);
  const dashRoot = `/dashboard/${slugSeg}`;

  const tabs = useMemo(() => {
    // Release-feature gate. A Beta tab is hidden unless its mapped key is
    // explicitly true in the server-resolved map. `!== true` mirrors
    // "Beta defaults OFF" for any omitted key (matches DashboardSidebar).
    const featureOff = (key: ReleaseFeatureKey): boolean =>
      releaseFeatures[key] !== true;
    const isOwnerAdmin = role === "owner" || role === "admin";
    return [
      // Owner/admin remote command view — first tab for the away decision-maker.
      {
        key: "pulse",
        label: t.pulse,
        href: `${dashRoot}/pulse`,
        icon: Activity,
        match: (p: string) => p.startsWith(`${dashRoot}/pulse`),
        hidden: !isOwnerAdmin,
      },
      {
        key: "front-desk",
        label: t.frontDesk,
        // Force the day grid (live board) — a stored week/month must not reopen.
        href: `${dashRoot}/center?view=day`,
        icon: LayoutGrid,
        match: (p: string) => p.startsWith(`${dashRoot}/center`),
      },
      {
        key: "queue",
        label: t.walkinQueue,
        href: `${dashRoot}/center?view=day#queue`,
        icon: Clock,
        match: () => false,
        badge: walkinQueueCount,
      },
      {
        key: "clients",
        label: t.clients,
        href: `${dashRoot}/clients`,
        icon: Users,
        match: (p: string) => p.startsWith(`${dashRoot}/clients`),
      },
      {
        key: "reports",
        label: t.reports,
        href: `${dashRoot}/reports`,
        // Mirrors the sidebar swap (BarChart2 → TrendingUp). Reads as
        // analytics rather than generic "bars".
        icon: TrendingUp,
        match: (p: string) => p.startsWith(`${dashRoot}/reports`),
        // Reports = owner/admin KPI/revenue overview. Gate on BOTH the release
        // flag AND the role so mobile matches the sidebar + the /reports page's
        // own server-side redirect — otherwise a receptionist saw a Reports tab
        // that just bounced them home.
        hidden: featureOff("advanced_reports") || !isOwnerAdmin,
      },
      {
        key: "settings",
        label: t.settings,
        href: `${dashRoot}/settings`,
        icon: SettingsIcon,
        match: (p: string) => p.startsWith(`${dashRoot}/settings`),
      },
    ];
  }, [
    dashRoot,
    t.clients,
    t.frontDesk,
    t.pulse,
    t.reports,
    t.settings,
    t.walkinQueue,
    role,
    walkinQueueCount,
    releaseFeatures,
  ]);

  return (
    <nav
      aria-label={t.primaryNav}
      className={cn(
        "md:hidden fixed inset-x-0 bottom-0 z-40",
        "border-t border-nq-border/40 bg-nq-surface",
        "pb-[env(safe-area-inset-bottom)]",
      )}
    >
      <ul className="flex items-stretch justify-between">
        {tabs.filter((tab) => !tab.hidden).map((tab) => {
          const Icon = tab.icon;
          const active = tab.match(pathname);
          const showBadge = (tab.badge ?? 0) > 0;
          return (
            <li key={tab.key} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-14 w-full touch-manipulation flex-col items-center justify-center gap-0.5",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
                  active ? "text-nq-primary" : "text-nq-muted",
                )}
              >
                <span className="relative inline-flex">
                  <Icon className="h-5 w-5" aria-hidden />
                  {showBadge ? (
                    <Badge
                      variant="vip"
                      className="absolute -right-2 -top-1 h-4 min-w-4 px-1 text-[10px]"
                    >
                      {tab.badge}
                    </Badge>
                  ) : null}
                </span>
                <span className="text-[11px] font-medium leading-tight">
                  {tab.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
