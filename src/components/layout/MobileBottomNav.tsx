"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronRight,
  Clock,
  Ellipsis,
  Gift,
  History,
  Home,
  LayoutGrid,
  Megaphone,
  Scissors,
  Settings,
  Sparkles,
  Star,
  TrendingUp,
  UserCheck,
  Users,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { type ReleaseFeatureMap } from "@/components/layout/DashboardSidebar";
import { cn } from "@/shared/lib/cn";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  walkinQueueCount?: number;
  overdueCount?: number;
  role?: string;
  releaseFeatures?: ReleaseFeatureMap;
};

type MobileItem = {
  key: string;
  label: string;
  href: string;
  icon: typeof Home;
  match: (path: string) => boolean;
  badge?: number;
  urgent?: boolean;
};

/**
 * iPhone-first navigation: four predictable destinations plus one More sheet.
 * Secondary tools stay reachable without asking low-tech users to understand
 * the complete product map on every screen.
 */
export function MobileBottomNav({
  slug,
  walkinQueueCount = 0,
  overdueCount = 0,
  role,
  releaseFeatures = {},
}: Props) {
  const pathname = usePathname() ?? "";
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).nav, [language]);
  const [moreOpen, setMoreOpen] = useState(false);
  const isOwner = role === "owner" || role === "admin";
  const dashRoot = `/dashboard/${encodeURIComponent(slug)}`;
  const L = useCallback(
    (en: string, vi: string) => (language === "vi" ? vi : en),
    [language],
  );
  const queueBadge = overdueCount > 0 ? overdueCount : walkinQueueCount;

  useEffect(() => {
    if (!moreOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [moreOpen]);

  const primaryItems = useMemo<MobileItem[]>(() => {
    const common: MobileItem[] = [
      {
        key: "home",
        label: L("Home", "Trang chủ"),
        href: dashRoot,
        icon: Home,
        match: (p) => p === dashRoot,
      },
      {
        key: "today",
        label: L("Today", "Hôm nay"),
        href: `${dashRoot}/center?view=day`,
        icon: LayoutGrid,
        match: (p) => p.startsWith(`${dashRoot}/center`),
      },
      {
        key: "clients",
        label: t.clients,
        href: `${dashRoot}/clients`,
        icon: Users,
        match: (p) => p.startsWith(`${dashRoot}/clients`),
      },
    ];

    if (isOwner) {
      common.push({
        key: "reports",
        label: L("Business", "Kinh doanh"),
        href:
          releaseFeatures.advanced_reports === true
            ? `${dashRoot}/reports`
            : `${dashRoot}/pulse`,
        icon: TrendingUp,
        match: (p) =>
          p.startsWith(`${dashRoot}/reports`) ||
          p.startsWith(`${dashRoot}/pulse`),
      });
    } else {
      common.push({
        key: "queue",
        label: L("Waiting", "Đang chờ"),
        href: `${dashRoot}/center?view=day#queue`,
        icon: Clock,
        match: () => false,
        badge: queueBadge,
        urgent: overdueCount > 0,
      });
    }
    return common;
  }, [L, dashRoot, isOwner, overdueCount, queueBadge, releaseFeatures.advanced_reports, t.clients]);

  const moreItems = useMemo<MobileItem[]>(() => {
    const items: MobileItem[] = [
      {
        key: "queue",
        label: L("Waiting customers", "Khách đang chờ"),
        href: `${dashRoot}/center?view=day#queue`,
        icon: Clock,
        match: () => false,
        badge: queueBadge,
        urgent: overdueCount > 0,
      },
      {
        key: "calendar",
        label: L("Calendar", "Lịch làm việc"),
        href: `${dashRoot}/center?view=week`,
        icon: CalendarDays,
        match: () => false,
      },
    ];
    if (isOwner) {
      items.push(
        { key: "staff", label: t.staff, href: `${dashRoot}/setup/staff`, icon: UserCheck, match: (p) => p.startsWith(`${dashRoot}/setup/staff`) },
        { key: "services", label: t.services, href: `${dashRoot}/setup/services`, icon: Scissors, match: (p) => p.startsWith(`${dashRoot}/setup/services`) },
      );
      if (releaseFeatures.reviews === true) items.push({ key: "reviews", label: t.reviews, href: `${dashRoot}/reviews`, icon: Star, match: (p) => p.startsWith(`${dashRoot}/reviews`) });
      if (releaseFeatures.loyalty === true) items.push({ key: "loyalty", label: t.loyalty, href: `${dashRoot}/setup/loyalty`, icon: Gift, match: (p) => p.startsWith(`${dashRoot}/setup/loyalty`) });
      if (releaseFeatures.marketing === true) items.push({ key: "marketing", label: t.marketing, href: `${dashRoot}/marketing`, icon: Megaphone, match: (p) => p.startsWith(`${dashRoot}/marketing`) });
      items.push(
        { key: "approvals", label: t.approvals, href: `${dashRoot}/approvals`, icon: Sparkles, match: (p) => p.startsWith(`${dashRoot}/approvals`) },
        { key: "activity", label: t.activity, href: `${dashRoot}/activity`, icon: History, match: (p) => p.startsWith(`${dashRoot}/activity`) },
      );
    }
    items.push({ key: "settings", label: t.settings, href: `${dashRoot}/settings`, icon: Settings, match: (p) => p.startsWith(`${dashRoot}/settings`) });
    return items;
  }, [L, dashRoot, isOwner, overdueCount, queueBadge, releaseFeatures, t]);

  const secondaryActive = moreItems.some((item) => item.match(pathname));
  const moreBadge = isOwner ? queueBadge : 0;

  return (
    <>
      <nav
        data-mobile-bottom-nav
        aria-label={t.primaryNav}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-nq-surface/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_30px_rgba(0,0,0,0.22)] backdrop-blur-xl xl:hidden"
      >
        <ul className="mx-auto grid max-w-3xl grid-cols-5">
          {primaryItems.map((item) => (
            <MobileTab key={item.key} item={item} active={item.match(pathname)} />
          ))}
          <li>
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-expanded={moreOpen}
              className={cn(
                "relative flex min-h-[3.75rem] w-full touch-manipulation flex-col items-center justify-center gap-1 px-1",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nq-primary/45",
                secondaryActive || moreOpen ? "text-nq-primary" : "text-nq-muted",
              )}
            >
              <span className="relative inline-flex">
                <Ellipsis className="h-6 w-6" aria-hidden />
                {moreBadge > 0 ? <Badge variant={overdueCount > 0 ? "danger" : "vip"} className="absolute -right-3 -top-1 h-4 min-w-4 px-1 text-[10px]">{moreBadge}</Badge> : null}
              </span>
              <span className="max-w-full truncate text-[11px] font-semibold leading-none">{L("More", "Thêm")}</span>
            </button>
          </li>
        </ul>
      </nav>

      {moreOpen ? (
        <div className="md:hidden fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label={L("More tools", "Công cụ khác")}>
          <button className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMoreOpen(false)} aria-label={L("Close", "Đóng")} />
          <section className="absolute inset-x-0 bottom-0 max-h-[82dvh] overflow-y-auto rounded-t-[1.75rem] border-t border-white/10 bg-nq-surface px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl">
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-nq-muted/35" aria-hidden />
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold tracking-tight text-nq-foreground">{L("More", "Thêm")}</h2>
                <p className="mt-0.5 text-sm text-nq-muted">{L("Everything else, in one place", "Các chức năng khác ở cùng một nơi")}</p>
              </div>
              <button type="button" onClick={() => setMoreOpen(false)} className="flex h-11 w-11 items-center justify-center rounded-full bg-nq-bg text-nq-muted" aria-label={L("Close", "Đóng")}><X className="h-5 w-5" aria-hidden /></button>
            </div>
            <ul className="overflow-hidden rounded-2xl border border-nq-border/40 bg-nq-bg/45">
              {moreItems.map((item, index) => {
                const Icon = item.icon;
                return (
                  <li key={item.key} className={index ? "border-t border-nq-border/30" : undefined}>
                    <Link href={item.href} onClick={() => setMoreOpen(false)} className="flex min-h-14 touch-manipulation items-center gap-3 px-4 py-2.5 active:bg-nq-primary/10">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-nq-primary/12 text-nq-primary"><Icon className="h-5 w-5" aria-hidden /></span>
                      <span className="min-w-0 flex-1 text-[15px] font-semibold text-nq-foreground">{item.label}</span>
                      {(item.badge ?? 0) > 0 ? <Badge variant={item.urgent ? "danger" : "vip"}>{item.badge}</Badge> : null}
                      <ChevronRight className="h-5 w-5 shrink-0 text-nq-muted/60" aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      ) : null}
    </>
  );
}

function MobileTab({ item, active }: { item: MobileItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <li>
      <Link href={item.href} aria-current={active ? "page" : undefined} className={cn("relative flex min-h-[3.75rem] touch-manipulation flex-col items-center justify-center gap-1 px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nq-primary/45", active ? "text-nq-primary" : "text-nq-muted")}>
        <span className="relative inline-flex">
          <Icon className={cn("h-6 w-6", active && "stroke-[2.4]")} aria-hidden />
          {(item.badge ?? 0) > 0 ? <Badge variant={item.urgent ? "danger" : "vip"} className="absolute -right-3 -top-1 h-4 min-w-4 px-1 text-[10px]">{item.badge}</Badge> : null}
        </span>
        <span className="max-w-full truncate text-[11px] font-semibold leading-none">{item.label}</span>
      </Link>
    </li>
  );
}
