"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  LayoutGrid,
  MessageSquare,
  Plus,
  Scissors,
  Settings as SettingsIcon,
  ShieldAlert,
  Sparkles,
  Star,
  TrendingUp,
  UserCheck,
  Users,
} from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import type { OwnerSalonSummary } from "@/shared/dashboard/salonOwnerActions";
import type { SubscriptionPlan } from "@/shared/lib/subscriptionPlans";

type Props = {
  slug: string;
  role: string;
  salonName: string;
  walkinQueueCount?: number;
  /** When > 0, the Walk-in Queue badge flips red (regardless of
   * `walkinQueueCount`). Driven by overdue in-progress bookings. */
  overdueCount?: number;
  messagesCount?: number;
  /** Owner-only: every salon this user owns. The footer renders a
   * switcher dropdown when this list contains > 1 entry (the current
   * salon is always one of them; the dropdown lists the others). */
  salons?: OwnerSalonSummary[];
  /** Hides plan-gated items (e.g. Reviews) for free salons. */
  subscriptionPlan?: SubscriptionPlan;
  /**
   * Collapse state — owned by DashboardShell so a single hook instance
   * drives both the aside's `--nq-sidebar-w` CSS variable AND the
   * sidebar's internal layout. Wiring this through props (instead of
   * calling useSidebarCollapsed here) prevents the duplicate-state
   * bug where the toggle button would flip the icon but never update
   * the actual width.
   */
  collapsed: boolean;
  onToggleCollapsed: () => void;
};

type NavItem = {
  key: string;
  label: string;
  href: string | null;
  icon: typeof LayoutGrid;
  /** When set, render a Badge with this count next to the label (when > 0). */
  badge?: number;
  /** Override the badge text — used by the static "Soon" pill on Messages. */
  badgeLabel?: string;
  /** Override badge color: gold (default), red (urgent), muted (placeholder). */
  badgeTone?: "gold" | "red" | "muted";
  /** Match logic for the active state. Pathname matchers run in priority order. */
  match: (pathname: string) => boolean;
  /** Disabled placeholder (no href). */
  disabled?: boolean;
  /** When true, item is not rendered in the sidebar (route still accessible via URL). */
  hidden?: boolean;
};

/** Visual grouping; rendered as a thin border between sections. */
type NavSection = {
  key: string;
  items: NavItem[];
};

/**
 * Persistent left rail for `/dashboard/[slug]/*`. Sits OUTSIDE the
 * Front Desk three-zone main content area — see DASHBOARD_LAYOUT_RULES
 * §9. Width transitions between 240px and 64px via the
 * `--nq-sidebar-w` CSS variable that DashboardShell publishes.
 */
export function DashboardSidebar({
  slug,
  role,
  salonName,
  walkinQueueCount = 0,
  overdueCount = 0,
  messagesCount = 0,
  salons,
  collapsed,
  onToggleCollapsed,
  subscriptionPlan = "free",
}: Props) {
  const pathname = usePathname() ?? "";
  const { language } = useUserLanguage();
  const messages = useMemo(() => getUserMessages(language), [language]);
  const t = messages.nav;
  const toggle = onToggleCollapsed;

  const roleLabels = messages.chooseSalon.roleBadge;

  const otherSalons = useMemo(
    () => (salons ?? []).filter((s) => s.slug !== slug),
    [salons, slug],
  );
  const showSwitcher = otherSalons.length > 0;
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherTriggerRef = useRef<HTMLButtonElement | null>(null);
  const switcherPopoverRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click and on Escape — basic discoverability for
  // the simple HTML/React popover (no portal, no animation per task).
  useEffect(() => {
    if (!switcherOpen) return;
    const onDown = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (!target) return;
      if (switcherTriggerRef.current?.contains(target)) return;
      if (switcherPopoverRef.current?.contains(target)) return;
      setSwitcherOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setSwitcherOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [switcherOpen]);

  // Auto-close when the user collapses the sidebar — the trigger
  // disappears and the dropdown would become an orphan otherwise.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional derived sync: hide orphaned dropdown when sidebar collapses
    if (collapsed && switcherOpen) setSwitcherOpen(false);
  }, [collapsed, switcherOpen]);

  const slugSeg = encodeURIComponent(slug);
  const dashRoot = `/dashboard/${slugSeg}`;

  // Sections render with thin separator dividers between them.
  // Settings sits in its OWN trailing section so it gets visually
  // pushed to the bottom (separator above) per the new info hierarchy.
  const sections: NavSection[] = useMemo(
    () => [
      // 1. Live operations — what the receptionist looks at right now.
      {
        key: "live",
        items: [
          {
            key: "front-desk",
            label: t.frontDesk,
            href: `${dashRoot}/center`,
            icon: LayoutGrid,
            match: (p) => p.startsWith(`${dashRoot}/center`),
          },
          {
            key: "queue",
            label: t.walkinQueue,
            // Center anchors a queue panel; deep-link via #queue.
            href: `${dashRoot}/center#queue`,
            icon: Clock,
            match: () => false,
            // Combined badge: overdue count takes precedence over
            // waiting count (so the receptionist sees "1 overdue" in
            // red, not "3 waiting" in gold). When ONLY waiting > 0, we
            // surface the waiting count in gold.
            badge:
              overdueCount > 0
                ? overdueCount
                : walkinQueueCount > 0
                  ? walkinQueueCount
                  : 0,
            badgeTone: overdueCount > 0 ? "red" : "gold",
          },
          {
            key: "calendar",
            label: t.calendar,
            // Center supports a week view via ?view=week (no separate route yet).
            href: `${dashRoot}/center?view=week`,
            icon: Calendar,
            match: () => false,
          },
        ],
      },
      // 2. Tenant data — who/what the salon offers.
      {
        key: "data",
        items: [
          {
            key: "clients",
            label: t.clients,
            href: `${dashRoot}/clients`,
            icon: Users,
            match: (p) => p.startsWith(`${dashRoot}/clients`),
          },
          {
            key: "staff",
            label: t.staff,
            href: `${dashRoot}/setup/staff`,
            icon: UserCheck,
            match: (p) => p.startsWith(`${dashRoot}/setup/staff`),
          },
          {
            key: "services",
            label: t.services,
            href: `${dashRoot}/setup/services`,
            icon: Scissors,
            match: (p) => p.startsWith(`${dashRoot}/setup/services`),
          },
        ],
      },
      // 3. Insight + lifecycle.
      {
        key: "insight",
        items: [
          {
            key: "reports",
            label: t.reports,
            href: `${dashRoot}/reports`,
            // TrendingUp reads as "business analytics" more than the
            // prior BarChart2.
            icon: TrendingUp,
            match: (p) => p.startsWith(`${dashRoot}/reports`),
          },
          {
            key: "reviews",
            label: t.reviews,
            href: `${dashRoot}/reviews`,
            icon: Star,
            match: (p) => p.startsWith(`${dashRoot}/reviews`),
            hidden: subscriptionPlan === "free",
          },
          {
            key: "no-show-protection",
            label: t.noShowProtection,
            href: `${dashRoot}/no-show-protection`,
            icon: ShieldAlert,
            match: (p) => p.startsWith(`${dashRoot}/no-show-protection`),
            hidden: true,
          },
          {
            key: "messages",
            label: t.messages,
            href: null,
            icon: MessageSquare,
            match: () => false,
            // Static "Soon" pill until messaging ships.
            badgeLabel: t.messagesSoonBadge,
            badgeTone: "muted",
            disabled: true,
          },
          {
            key: "marketing",
            label: t.marketing,
            href: null,
            icon: Sparkles,
            match: () => false,
            disabled: true,
          },
        ],
      },
      // 4. Settings — separator pushes this to the bottom of the rail.
      {
        key: "config",
        items: [
          {
            key: "settings",
            label: t.settings,
            href: `${dashRoot}/settings`,
            icon: SettingsIcon,
            match: (p) => p.startsWith(`${dashRoot}/settings`),
          },
        ],
      },
    ],
    [
      dashRoot,
      t.calendar,
      t.clients,
      t.frontDesk,
      t.marketing,
      t.messages,
      t.messagesSoonBadge,
      t.noShowProtection,
      t.reports,
      t.reviews,
      t.services,
      t.settings,
      t.staff,
      t.walkinQueue,
      walkinQueueCount,
      overdueCount,
      subscriptionPlan,
    ],
  );

  // Reference the prop so unused-var lint stays clean. messagesCount is
  // intentionally not surfaced in the new layout (Messages shows the
  // static "Soon" badge instead of a numeric count).
  void messagesCount;

  return (
    <aside
      // Hidden on mobile (bottom-bar takes over per §9.2).
      className={cn(
        "hidden md:flex fixed inset-y-0 left-0 z-40 flex-col border-r border-nq-border/40 bg-nq-surface text-nq-foreground",
        // Width follows CSS var so DashboardShell main padding stays in sync.
        "w-[var(--nq-sidebar-w)]",
      )}
      aria-label={t.primaryNav}
    >
      {collapsed ? (
        // Collapsed: only the toggle, right-aligned within the 64px
        // rail. The NQ logo + salon name don't fit at this width
        // alongside a 36px button (NQ + gap + button = 80px > 40px
        // content area), so we drop them. The toggle alone gives the
        // user a clear way back to the expanded shell where both
        // re-appear.
        <div className="flex items-center justify-end px-2 py-4 border-b border-nq-border/40">
          <button
            type="button"
            onClick={toggle}
            aria-label={t.expandSidebar}
            aria-expanded={false}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-nq-border/40 bg-nq-surface/40 text-nq-muted transition-colors hover:bg-nq-surface/80 hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45"
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3 px-3 py-4 border-b border-nq-border/40">
          <Link
            href="/"
            className="flex items-center gap-2 min-w-0 flex-1 rounded-lg px-1 py-1 transition-colors hover:bg-nq-surface/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45"
            aria-label="NailIQ home"
          >
            <span
              aria-hidden
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-nq-primary/15 text-sm font-bold tracking-tight text-nq-primary"
            >
              NQ
            </span>
            <span className="min-w-0 truncate text-sm font-semibold text-nq-foreground">
              {salonName}
            </span>
          </Link>
          <button
            type="button"
            onClick={toggle}
            aria-label={t.collapseSidebar}
            aria-expanded={true}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-nq-border/40 bg-nq-surface/40 text-nq-muted transition-colors hover:bg-nq-surface/80 hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      <nav
        className="flex-1 overflow-y-auto px-2 py-3"
        aria-label={t.primaryNav}
      >
        {sections.map((section, sectionIdx) => (
          <div key={section.key}>
            {sectionIdx > 0 ? (
              <div
                className="my-2 border-t border-nq-border/30"
                aria-hidden
              />
            ) : null}
            <ul className="flex flex-col gap-1">
              {section.items.filter((item) => !item.hidden).map((item) => (
                <li key={item.key}>
                  <SidebarRow
                    item={item}
                    active={item.href ? item.match(pathname) : false}
                    collapsed={collapsed}
                  />
                </li>
              ))}
            </ul>
            {/* Quick action sits inside the insight section so the
                separator before Settings naturally wraps both the
                insight rows AND the +Walk-in button. */}
            {section.key === "insight" ? (
              <QuickAddWalkinButton
                slug={slug}
                collapsed={collapsed}
                label={t.quickAddWalkin}
              />
            ) : null}
          </div>
        ))}
      </nav>

      <div className="relative mt-auto border-t border-nq-border/40 px-2 py-3">
        {showSwitcher && !collapsed ? (
          <button
            ref={switcherTriggerRef}
            type="button"
            onClick={() => setSwitcherOpen((prev) => !prev)}
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            aria-label={t.switchSalon}
            className={cn(
              "flex w-full min-h-11 touch-manipulation items-center gap-3 rounded-lg px-2 py-2",
              "transition-colors hover:bg-nq-surface/80",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
              switcherOpen ? "bg-nq-surface/80" : "",
            )}
          >
            <SalonAvatar salonName={salonName} />
            <div className="min-w-0 flex-1 text-left">
              <p className="truncate text-sm font-medium text-nq-foreground">
                {salonName}
              </p>
              <p className="truncate text-xs text-nq-muted">
                {localizedRoleLabel(role, roleLabels)}
              </p>
            </div>
            <ChevronUp
              className={cn(
                "h-4 w-4 shrink-0 text-nq-muted transition-transform",
                switcherOpen ? "rotate-180" : "",
              )}
              aria-hidden
            />
          </button>
        ) : (
          <div
            // Footer stays left-aligned in both states (matches the
            // nav rows above) so the avatar pip's x-position is
            // stable when the user toggles collapse.
            className="flex items-center gap-3 rounded-lg px-2 py-2"
            title={collapsed ? `${salonName} · ${localizedRoleLabel(role, roleLabels)}` : undefined}
          >
            <SalonAvatar salonName={salonName} />
            {collapsed ? null : (
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-nq-foreground">
                  {salonName}
                </p>
                <p className="truncate text-xs text-nq-muted">
                  {localizedRoleLabel(role, roleLabels)}
                </p>
              </div>
            )}
          </div>
        )}

        {showSwitcher && switcherOpen && !collapsed ? (
          <div
            ref={switcherPopoverRef}
            role="menu"
            aria-label={t.switchSalon}
            className={cn(
              "absolute bottom-[calc(100%-0.25rem)] left-2 right-2 z-50",
              "rounded-lg border border-nq-border/40 bg-nq-surface p-1 shadow-nq-card",
            )}
          >
            <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
              {t.switchSalon}
            </p>
            <ul className="flex flex-col gap-0.5">
              {otherSalons.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/dashboard/${encodeURIComponent(s.slug)}/center`}
                    role="menuitem"
                    onClick={() => setSwitcherOpen(false)}
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-md px-2 py-2",
                      "text-sm text-nq-foreground transition-colors hover:bg-nq-surface/80",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
                    )}
                  >
                    <SalonAvatar salonName={s.name} />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function SidebarRow({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const Icon = item.icon;

  // Badge resolution:
  // - `badgeLabel` (string) wins; renders even on disabled rows
  //   (used for the static "Soon" pill on Messages).
  // - Otherwise show the numeric `badge` only when > 0 AND not disabled.
  const numericBadgeVisible = !item.disabled && (item.badge ?? 0) > 0;
  const stringBadgeVisible = !!item.badgeLabel;
  const showBadge = stringBadgeVisible || numericBadgeVisible;

  const tone = item.badgeTone ?? "gold";
  const badgeColorClass =
    tone === "red"
      ? "bg-nq-error text-nq-foreground"
      : tone === "muted"
        ? "bg-nq-surface/60 text-nq-muted border border-nq-border/40"
        : "bg-nq-primary text-nq-bg";

  const label = collapsed ? null : (
    <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
  );

  const badge = showBadge ? (
    <span
      className={cn(
        "ml-auto inline-flex shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none",
        badgeColorClass,
        collapsed
          ? "absolute -right-0.5 -top-0.5 h-4 min-w-4 px-1"
          : "h-5 min-w-5 px-1.5",
      )}
    >
      {item.badgeLabel ?? item.badge}
    </span>
  ) : null;

  // Nav rows stay left-aligned regardless of collapse state — icon
  // sits at the same x-position when expanded vs collapsed so the
  // user's eye doesn't have to re-find it on toggle. Collapsed uses a
  // tighter px to land the icon flush with the rail's left edge
  // (matches the toggle button's px-2 in the header).
  const baseClass = cn(
    "relative flex min-h-11 w-full touch-manipulation items-center gap-3 rounded-lg transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
    collapsed ? "px-3" : "px-2.5",
    item.disabled
      ? "cursor-not-allowed opacity-50 text-nq-muted"
      : active
        ? "bg-nq-primary/15 text-nq-primary"
        : "text-nq-muted hover:bg-nq-surface/80 hover:text-nq-foreground",
  );

  const content = (
    <>
      <Icon className="h-5 w-5 shrink-0" aria-hidden />
      {label}
      {badge}
    </>
  );

  if (item.disabled || !item.href) {
    return (
      <span
        className={baseClass}
        aria-disabled="true"
        title={collapsed ? item.label : undefined}
      >
        {content}
      </span>
    );
  }

  return (
    <Link
      href={item.href}
      className={baseClass}
      aria-current={active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
    >
      {content}
    </Link>
  );
}

type RoleBadgeMap = {
  owner: string;
  senior: string;
  nail_tech: string;
};

function localizedRoleLabel(role: string, labels: RoleBadgeMap): string {
  if (role === "owner") return labels.owner;
  if (role === "senior") return labels.senior;
  if (role === "nail_tech") return labels.nail_tech;
  // Fallback for unknown / future roles — keep the raw role name so it's
  // still parseable rather than collapsing to an English placeholder.
  return role || labels.nail_tech;
}

/**
 * Sidebar quick action — navigates to the receptionist Front Desk
 * with a `#queue` hash AND primes the queue-panel localStorage flag
 * so the slide-over auto-opens once the page loads. Cleaner UX than
 * just relying on the hash scroll.
 */
function QuickAddWalkinButton({
  slug,
  collapsed,
  label,
}: {
  slug: string;
  collapsed: boolean;
  label: string;
}) {
  const target = `/dashboard/${encodeURIComponent(slug)}/center#queue`;
  return (
    <Link
      href={target}
      onClick={() => {
        try {
          // Matches QUEUE_PANEL_OPEN_STORAGE_KEY in useQueuePanelOpen.
          // Inlined to avoid pulling the hook into a server-render-safe
          // sidebar; the contract is a one-line localStorage write.
          window.localStorage.setItem("nailiq-queue-panel-open", "1");
        } catch {
          /* ignore */
        }
      }}
      title={collapsed ? label : undefined}
      aria-label={label}
      className={cn(
        "mt-3 flex min-h-11 w-full touch-manipulation items-center gap-2 rounded-lg border border-nq-primary/40 px-3 text-sm font-semibold text-nq-primary transition-colors hover:bg-nq-primary/10",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
        collapsed ? "justify-center px-0" : "justify-start",
      )}
    >
      <Plus className="h-4 w-4 shrink-0" aria-hidden />
      {collapsed ? null : <span className="truncate">{label}</span>}
    </Link>
  );
}

function SalonAvatar({ salonName }: { salonName: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-nq-primary/15 text-xs font-bold tracking-tight text-nq-primary"
    >
      {(salonName.trim().charAt(0) || "S").toUpperCase()}
    </span>
  );
}
