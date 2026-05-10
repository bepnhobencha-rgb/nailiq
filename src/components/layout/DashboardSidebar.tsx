"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart2,
  Calendar,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  LayoutGrid,
  Megaphone,
  MessageSquare,
  Scissors,
  Settings as SettingsIcon,
  UserCheck,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/shared/lib/cn";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import type { OwnerSalonSummary } from "@/shared/dashboard/salonOwnerActions";

type Props = {
  slug: string;
  role: string;
  salonName: string;
  walkinQueueCount?: number;
  messagesCount?: number;
  /** Owner-only: every salon this user owns. The footer renders a
   * switcher dropdown when this list contains > 1 entry (the current
   * salon is always one of them; the dropdown lists the others). */
  salons?: OwnerSalonSummary[];
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
  /** Match logic for the active state. Pathname matchers run in priority order. */
  match: (pathname: string) => boolean;
  /** Disabled placeholder (no href). */
  disabled?: boolean;
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
  messagesCount = 0,
  salons,
  collapsed,
  onToggleCollapsed,
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
    if (collapsed && switcherOpen) setSwitcherOpen(false);
  }, [collapsed, switcherOpen]);

  const slugSeg = encodeURIComponent(slug);
  const dashRoot = `/dashboard/${slugSeg}`;

  const items: NavItem[] = useMemo(
    () => [
      {
        key: "front-desk",
        label: t.frontDesk,
        href: `${dashRoot}/center`,
        icon: LayoutGrid,
        match: (p) => p.startsWith(`${dashRoot}/center`),
      },
      {
        key: "calendar",
        label: t.calendar,
        // Center supports a week view via ?view=week (no separate route yet).
        href: `${dashRoot}/center?view=week`,
        icon: Calendar,
        match: () => false,
      },
      {
        key: "clients",
        label: t.clients,
        href: `${dashRoot}/clients`,
        icon: Users,
        match: (p) => p.startsWith(`${dashRoot}/clients`),
      },
      {
        key: "services",
        label: t.services,
        href: `${dashRoot}/setup/services`,
        icon: Scissors,
        match: (p) => p.startsWith(`${dashRoot}/setup/services`),
      },
      {
        key: "staff",
        label: t.staff,
        href: `${dashRoot}/setup/staff`,
        icon: UserCheck,
        match: (p) => p.startsWith(`${dashRoot}/setup/staff`),
      },
      {
        key: "queue",
        label: t.walkinQueue,
        // Center anchors a queue panel; deep-link via #queue.
        href: `${dashRoot}/center#queue`,
        icon: Clock,
        match: () => false,
        badge: walkinQueueCount,
      },
      {
        key: "messages",
        label: t.messages,
        href: null,
        icon: MessageSquare,
        match: () => false,
        badge: messagesCount,
        disabled: true,
      },
      {
        key: "reports",
        label: t.reports,
        href: `${dashRoot}/reports`,
        icon: BarChart2,
        match: (p) => p.startsWith(`${dashRoot}/reports`),
      },
      {
        key: "marketing",
        label: t.marketing,
        href: null,
        icon: Megaphone,
        match: () => false,
        disabled: true,
      },
      {
        key: "settings",
        label: t.settings,
        href: `${dashRoot}/settings`,
        icon: SettingsIcon,
        match: (p) => p.startsWith(`${dashRoot}/settings`),
      },
    ],
    [
      dashRoot,
      t.calendar,
      t.clients,
      t.frontDesk,
      t.marketing,
      t.messages,
      t.reports,
      t.services,
      t.settings,
      t.staff,
      t.walkinQueue,
      walkinQueueCount,
      messagesCount,
    ],
  );

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
          {collapsed ? null : (
            <span className="min-w-0 truncate text-sm font-semibold text-nq-foreground">
              {salonName}
            </span>
          )}
        </Link>
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? t.expandSidebar : t.collapseSidebar}
          aria-expanded={!collapsed}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-nq-border/40 bg-nq-surface/40 text-nq-muted transition-colors hover:bg-nq-surface/80 hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronLeft className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label={t.primaryNav}>
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.key}>
              <SidebarRow
                item={item}
                active={item.href ? item.match(pathname) : false}
                collapsed={collapsed}
              />
            </li>
          ))}
        </ul>
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
            className={cn(
              "flex items-center gap-3 rounded-lg px-2 py-2",
              collapsed ? "justify-center" : "",
            )}
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
  const showBadge = !item.disabled && (item.badge ?? 0) > 0;

  const label = collapsed ? null : (
    <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
  );

  const badge = showBadge ? (
    <Badge
      variant={active ? "default" : "muted"}
      className={cn(
        "ml-auto shrink-0",
        collapsed ? "absolute -right-0.5 -top-0.5 h-4 min-w-4 px-1 text-[10px]" : "",
      )}
    >
      {item.badge}
    </Badge>
  ) : null;

  const baseClass = cn(
    "relative flex min-h-11 w-full touch-manipulation items-center gap-3 rounded-lg px-2.5 transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
    collapsed ? "justify-center" : "",
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
