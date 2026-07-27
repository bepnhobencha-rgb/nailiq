"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar,
  Camera,
  ChevronDown,
  Gavel,
  Gift,
  History,
  Home,
  Hourglass,
  Package,
  ChevronLeft,
  Activity,
  ChevronRight,
  Check,
  ChevronUp,
  Clock,
  LayoutGrid,
  MessageSquare,
  Monitor,
  Ellipsis,
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
import { LogoutButton } from "@/components/dashboard/LogoutButton";
import { GlobalLanguageToggle } from "@/components/user/GlobalLanguageToggle";
import { cn } from "@/shared/lib/cn";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { useBasicMode } from "@/shared/dashboard/useBasicMode";
import type { OwnerSalonSummary } from "@/shared/dashboard/salonOwnerActions";
import type { SubscriptionPlan } from "@/shared/lib/subscriptionPlans";
import type { ReleaseFeatureKey } from "@/shared/features/featureRegistry";

/** Server-resolved release-feature visibility map (PR2). Booleans only — the
 *  registry/resolver runs server-side in the dashboard layout so this client
 *  component never imports the raw salon row. Missing key → treated as its
 *  registry default by the layout before it reaches here. */
export type ReleaseFeatureMap = Partial<Record<ReleaseFeatureKey, boolean>>;

type Props = {
  slug: string;
  role: string;
  salonName: string;
  walkinQueueCount?: number;
  /** Active online waitlist entries, kept separate from walk-ins. */
  waitlistCount?: number;
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
  /** Release-feature visibility (PR2). Beta nav items hide when their key is
   *  false; Base items are not gated. See `featureRegistry`. */
  releaseFeatures?: ReleaseFeatureMap;
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
  /** Authenticated user's email address for the user profile card in sidebar footer. */
  userEmail?: string | null;
  /** Count of pending Minh approval requests (owner/admin only). */
  pendingApprovalsCount?: number;
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
 * Basic Mode nav allow-list: the minimal front-desk set per the approved
 * cockpit spec — Live Board · Queue · Calendar · Customers · Settings.
 * Owner/marketing items (reports, reviews, loyalty, photos, combos,
 * messages, marketing) and tenant-config items (staff, services) are
 * hidden in Basic Mode. The routes stay reachable by URL; only the rail
 * is simplified. Balanced/Advanced (Basic Mode off) is unchanged.
 */
const BASIC_NAV_KEYS = new Set([
  "front-desk",
  "queue",
  "waitlist",
  "calendar",
  "clients",
  "settings",
]);

/**
 * The desktop rail follows the same iPhone-style hierarchy as mobile:
 * everyday work stays visible, while occasional owner/admin tools live
 * behind one predictable “More” disclosure. Routes remain fully reachable.
 */
const DESKTOP_PRIMARY_NAV_KEYS = new Set([
  "home",
  "pulse",
  "front-desk",
  "queue",
  "waitlist",
  "calendar",
  "clients",
  "staff",
  "services",
  "settings",
]);

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
  waitlistCount = 0,
  overdueCount = 0,
  messagesCount = 0,
  pendingApprovalsCount = 0,
  salons,
  collapsed,
  onToggleCollapsed,
  releaseFeatures = {},
  userEmail,
}: Props) {
  const pathname = usePathname() ?? "";
  const { language } = useUserLanguage();
  const messages = useMemo(() => getUserMessages(language), [language]);
  const t = messages.nav;
  const toggle = onToggleCollapsed;
  // Basic Mode (per-device) simplifies the rail to the front-desk essentials.
  // SSR-safe: starts off, hydrates from localStorage post-mount.
  const { basicMode } = useBasicMode();

  const roleLabels = messages.chooseSalon.roleBadge;

  const otherSalons = useMemo(
    () => (salons ?? []).filter((s) => s.slug !== slug),
    [salons, slug],
  );
  // Salon switching now lives inside the single account menu below.
  const showSwitcher = otherSalons.length > 0;

  // Account menu state (identity + salon switch + sign out) — one menu.
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const userMenuPopoverRef = useRef<HTMLDivElement | null>(null);

  // Account menu close on outside click and on Escape
  useEffect(() => {
    if (!userMenuOpen) return;
    const onDown = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (!target) return;
      if (userMenuTriggerRef.current?.contains(target)) return;
      if (userMenuPopoverRef.current?.contains(target)) return;
      setUserMenuOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [userMenuOpen]);

  const slugSeg = encodeURIComponent(slug);
  const dashRoot = `/dashboard/${slugSeg}`;

  // Sections render with thin separator dividers between them.
  // Settings sits in its OWN trailing section so it gets visually
  // pushed to the bottom (separator above) per the new info hierarchy.
  const sections: NavSection[] = useMemo(() => {
    // Release-feature gate. A Beta nav item is hidden unless its mapped key is
    // explicitly true in the server-resolved map. Base items are never passed
    // here. `!== true` mirrors "Beta defaults OFF" for any omitted key.
    const featureOff = (key: ReleaseFeatureKey): boolean =>
      releaseFeatures[key] !== true;
    return [
      // 1. Live operations — what the receptionist looks at right now.
      {
        key: "live",
        items: [
          {
            key: "home",
            label: language === "vi" ? "Trang chủ" : "Home",
            href: dashRoot,
            icon: Home,
            match: (p) => p === dashRoot,
            hidden: role !== "owner" && role !== "admin",
          },
          {
            // Owner/admin remote command view — the away decision-maker's home.
            key: "pulse",
            label: t.pulse,
            href: `${dashRoot}/pulse`,
            icon: Activity,
            match: (p) => p.startsWith(`${dashRoot}/pulse`),
            hidden: role !== "owner" && role !== "admin",
          },
          {
            key: "front-desk",
            label: t.frontDesk,
            // Force the day grid (the live board). Without ?view=day a stored
            // week/month from a prior Calendar visit would reopen here.
            href: `${dashRoot}/center?view=day`,
            icon: LayoutGrid,
            match: (p) => p.startsWith(`${dashRoot}/center`),
            hidden: featureOff("receptionist_center"),
          },
          {
            key: "queue",
            label: language === "vi" ? "Khách vãng lai" : "Walk-ins",
            // Queue panel renders only in the day view — force it + deep-link #queue.
            href: `${dashRoot}/center?view=day#queue`,
            icon: Clock,
            match: () => false,
            hidden:
              featureOff("receptionist_center") || featureOff("walkin_queue"),
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
            key: "waitlist",
            label:
              language === "vi"
                ? "Danh sách chờ online"
                : "Online waitlist",
            href: `${dashRoot}/center?view=day#waitlist`,
            icon: Hourglass,
            match: () => false,
            hidden: featureOff("receptionist_center"),
            badge: waitlistCount > 0 ? waitlistCount : undefined,
            badgeTone: "gold",
          },
          {
            key: "calendar",
            label: t.calendar,
            // Center supports a week view via ?view=week (no separate route yet).
            href: `${dashRoot}/center?view=week`,
            icon: Calendar,
            match: () => false,
            hidden: featureOff("receptionist_center"),
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
            // Client profiles expose PII — desk roles only (owner/senior/
            // admin/receptionist). Hide from nail_tech so it can't bounce.
            hidden: role === "nail_tech",
          },
          {
            key: "staff",
            label: t.staff,
            href: `${dashRoot}/setup/staff`,
            icon: UserCheck,
            match: (p) => p.startsWith(`${dashRoot}/setup/staff`),
            // Salon config = owner/admin only (matches the page gate).
            hidden: role !== "owner" && role !== "admin",
          },
          {
            key: "services",
            label: t.services,
            href: `${dashRoot}/setup/services`,
            icon: Scissors,
            match: (p) => p.startsWith(`${dashRoot}/setup/services`),
            hidden: role !== "owner" && role !== "admin",
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
            // Release flag (advanced_reports, default OFF) + role: the KPI/
            // revenue overview is owner + admin only (matches the page gate).
            hidden:
              featureOff("advanced_reports") ||
              (role !== "owner" && role !== "admin"),
          },
          {
            key: "reviews",
            label: t.reviews,
            href: `${dashRoot}/reviews`,
            icon: Star,
            match: (p) => p.startsWith(`${dashRoot}/reviews`),
            // Plan flag + role: owner + admin only (matches the page gate).
            hidden:
              featureOff("reviews") || (role !== "owner" && role !== "admin"),
          },
          {
            key: "loyalty",
            label: t.loyalty,
            href: `${dashRoot}/setup/loyalty`,
            icon: Gift,
            match: (p) => p.startsWith(`${dashRoot}/setup/loyalty`),
            // Release flag + role: config is owner/admin only (matches page gate).
            hidden:
              featureOff("loyalty") || (role !== "owner" && role !== "admin"),
          },
          {
            key: "photos",
            label: t.photos,
            href: `${dashRoot}/photos`,
            icon: Camera,
            match: (p) => p.startsWith(`${dashRoot}/photos`),
            // Plan flag + role: owner + admin + senior (matches the page gate);
            // hidden from receptionist / nail_tech.
            hidden:
              featureOff("photos") ||
              (role !== "owner" && role !== "admin" && role !== "senior"),
          },
          {
            key: "combos",
            label: t.combos,
            href: `${dashRoot}/combos`,
            icon: Package,
            match: (p) => p.startsWith(`${dashRoot}/combos`),
            // Release flag: Combos is Beta, default OFF.
            hidden: featureOff("combos"),
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
            key: "disputes",
            label: t.disputes,
            href: `${dashRoot}/disputes`,
            icon: Gavel,
            match: (p) => p.startsWith(`${dashRoot}/disputes`),
            // Financial data — owner + admin only (matches the page gate).
            hidden: role !== "owner" && role !== "admin",
          },
          {
            key: "ai-control-center",
            label: language === "vi" ? "Trung tâm AI" : "AI Control Center",
            href: `${dashRoot}/ai`,
            icon: Sparkles,
            match: (p) =>
              p.startsWith(`${dashRoot}/ai`) ||
              p.startsWith(`${dashRoot}/manager`) ||
              p.startsWith(`${dashRoot}/approvals`),
            hidden:
              featureOff("ai_control_center") ||
              (role !== "owner" && role !== "admin"),
            badge: pendingApprovalsCount > 0 ? pendingApprovalsCount : undefined,
            badgeTone: "red" as const,
          },
          {
            key: "activity",
            label: t.activity,
            href: `${dashRoot}/activity`,
            icon: History,
            match: (p) => p.startsWith(`${dashRoot}/activity`),
            // Full non-AI audit/comms log — owner + admin only.
            hidden: role !== "owner" && role !== "admin",
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
            href: `${dashRoot}/marketing`,
            icon: Sparkles,
            match: (p) => p.startsWith(`${dashRoot}/marketing`),
            // Owner/admin only, and behind the Marketing release flag.
            hidden:
              featureOff("marketing") ||
              (role !== "owner" && role !== "admin"),
          },
        ],
      },
      // 4. Settings — separator pushes this to the bottom of the rail.
      {
        key: "config",
        items: [
          {
            key: "sessions",
            label: "Sessions",
            href: `${dashRoot}/sessions`,
            icon: Monitor,
            match: (p) => p.startsWith(`${dashRoot}/sessions`),
            hidden: !["owner", "admin", "manager"].includes(role),
          },
          {
            key: "settings",
            label: t.settings,
            href: `${dashRoot}/settings`,
            icon: SettingsIcon,
            match: (p) => p.startsWith(`${dashRoot}/settings`),
          },
        ],
      },
    ];
  }, [
    dashRoot,
    language,
    role,
      t.activity,
      t.calendar,
      t.clients,
      t.disputes,
      t.frontDesk,
      t.loyalty,
      t.marketing,
      t.messages,
      t.messagesSoonBadge,
      t.noShowProtection,
      t.pulse,
      t.reports,
      t.photos,
      t.combos,
      t.reviews,
      t.services,
      t.settings,
      t.staff,
      walkinQueueCount,
    overdueCount,
    waitlistCount,
    pendingApprovalsCount,
    releaseFeatures,
    ],
  );

  // Basic Mode simplifies the rail to front-desk essentials — but only for
  // front-desk roles. Management roles (owner/admin) always keep the full nav
  // so they can reach Staff/Services/Reports/Settings even on a salon that
  // forces Basic Mode for its receptionists.
  const isManager = role === "owner" || role === "admin";
  // Reception is simple by default. Front-desk staff should never have to
  // learn the owner's analytics/configuration map just to run today's desk.
  const navIsBasic =
    role === "receptionist" ||
    role === "nail_tech" ||
    (basicMode && !isManager);
  // Basic Mode keeps only the front-desk essentials. Management mode keeps
  // daily work visible and folds occasional tools into a single More section.
  const visibleSections = useMemo<NavSection[]>(() => {
    if (navIsBasic) {
      return sections
        .map((s) => ({
          ...s,
          items: s.items.filter((i) => BASIC_NAV_KEYS.has(i.key)),
        }))
        .filter((s) => s.items.length > 0);
    }

    const primary = sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) =>
          DESKTOP_PRIMARY_NAV_KEYS.has(item.key),
        ),
      }))
      .filter((section) => section.items.length > 0);
    const moreItems = sections.flatMap((section) =>
      section.items.filter(
        (item) => !DESKTOP_PRIMARY_NAV_KEYS.has(item.key) && !item.hidden,
      ),
    );
    const configIndex = primary.findIndex((section) => section.key === "config");
    const insertAt = configIndex >= 0 ? configIndex : primary.length;

    return [
      ...primary.slice(0, insertAt),
      ...(moreItems.length ? [{ key: "more", items: moreItems }] : []),
      ...primary.slice(insertAt),
    ];
  }, [sections, navIsBasic]);
  const quickAddSectionKey = navIsBasic ? "live" : "more";

  // Reference the prop so unused-var lint stays clean. messagesCount is
  // intentionally not surfaced in the new layout (Messages shows the
  // static "Soon" badge instead of a numeric count).
  void messagesCount;

  // Hover-expand: when collapsed, hovering reveals the full sidebar as an
  // overlay without shifting the main content (--nq-sidebar-w stays 4rem).
  const [hoverOpen, setHoverOpen] = useState(false);
  const showExpanded = !collapsed || hoverOpen;

  return (
    <aside
      data-dashboard-sidebar
      // iPad and smaller use the touch-first bottom bar. The full navigation
      // rail starts at xl, where it no longer steals working room from the
      // live appointment timeline.
      className={cn(
        "fixed inset-y-0 left-0 z-40 hidden flex-col border-r text-nq-foreground xl:flex",
        "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] overflow-hidden",
      )}
      style={{
        width: showExpanded ? "15rem" : "4rem",
        // Glass morphism: 88% of page bg (or DRC tint) + 12% transparent → semi-opaque
        // with backdrop-blur creates depth without hiding the brand color.
        background: "color-mix(in srgb, var(--drc-page-bg, #0d0e12) 88%, transparent 12%)",
        backdropFilter: "blur(16px) saturate(1.3)",
        borderColor: "rgba(255,255,255,0.06)",
        boxShadow: hoverOpen && collapsed
          ? "4px 0 40px rgba(0,0,0,0.55), inset -1px 0 0 rgba(255,255,255,0.05)"
          : "inset -1px 0 0 rgba(255,255,255,0.03)",
      }}
      onMouseEnter={() => setHoverOpen(true)}
      onMouseLeave={() => setHoverOpen(false)}
      aria-label={t.primaryNav}
    >
      {!showExpanded ? (
        // Icon-only rail: just the expand toggle
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
            href={`/dashboard/${encodeURIComponent(slug)}`}
            className="flex items-center gap-2 min-w-0 flex-1 rounded-lg px-1 py-1 transition-colors hover:bg-nq-surface/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45"
            aria-label="Dashboard home"
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
        className="flex-1 overflow-y-auto px-2 py-3 nq-scrollbar-hide"
        aria-label={t.primaryNav}
      >
        {visibleSections.map((section, sectionIdx) => (
          <div key={section.key}>
            {sectionIdx > 0 ? (
              <div
                className="my-2 border-t border-nq-border/30"
                aria-hidden
              />
            ) : null}
            {section.key === "more" ? (
              <SidebarMoreSection
                items={section.items}
                pathname={pathname}
                collapsed={!showExpanded}
                label={language === "vi" ? "Thêm" : "More"}
              />
            ) : (
              <ul className="flex flex-col gap-1">
                {section.items.filter((item) => !item.hidden).map((item) => (
                  <li key={item.key}>
                    <SidebarRow
                      item={item}
                      active={item.href ? item.match(pathname) : false}
                      collapsed={!showExpanded}
                    />
                  </li>
                ))}
              </ul>
            )}
            {/* Quick action sits with the More section so the separator
                before Settings naturally wraps both the occasional tools
                AND the +Walk-in button. In Basic Mode More is hidden, so
                it would move under "live" —
                but the Basic header already shows a primary "+ Walk-in",
                so we drop the sidebar duplicate in Basic Mode (DoD #4:
                no duplicate + Walk-in). We also drop it on the Front Desk
                (/center) itself, where the board header already shows a
                contextual "+ Walk-in" — the sidebar copy is only the global
                entry point for OTHER pages. */}
            {section.key === quickAddSectionKey &&
            !navIsBasic &&
            !pathname.includes("/center") ? (
              <QuickAddWalkinButton
                slug={slug}
                collapsed={!showExpanded}
                label={t.quickAddWalkin}
              />
            ) : null}
          </div>
        ))}
      </nav>

      <div className="relative mt-auto border-t border-nq-border/40 px-2 py-3">
        {/* Single account menu: identity + salon switch + sign out.
            One avatar trigger; works expanded (popover above) and collapsed
            (flyout beside the rail). */}
        <button
          ref={userMenuTriggerRef}
          type="button"
          onClick={() => setUserMenuOpen((prev) => !prev)}
          aria-haspopup="menu"
          aria-expanded={userMenuOpen}
          title={!showExpanded ? userEmail ?? "Account" : undefined}
          className={cn(
            "flex w-full min-h-11 touch-manipulation items-center gap-3 rounded-lg px-2 py-2",
            "transition-colors hover:bg-nq-surface/80",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
            !showExpanded ? "justify-center" : "",
            userMenuOpen ? "bg-nq-surface/80" : "",
          )}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nq-primary/20 text-xs font-semibold text-nq-primary">
            {userEmail?.charAt(0).toUpperCase() ?? "U"}
          </div>
          {!showExpanded ? null : (
            <>
              <div className="min-w-0 flex-1 text-left">
                <p className="truncate text-sm font-medium text-nq-foreground">
                  {userEmail ?? "User"}
                </p>
                <p className="truncate text-xs text-nq-muted">
                  {localizedRoleLabel(role, roleLabels)}
                </p>
              </div>
              <ChevronUp
                className={cn(
                  "h-4 w-4 shrink-0 text-nq-muted transition-transform",
                  userMenuOpen ? "rotate-180" : "",
                )}
                aria-hidden
              />
            </>
          )}
        </button>

        {userMenuOpen ? (
          <div
            ref={userMenuPopoverRef}
            role="menu"
            className={cn(
              "absolute z-50 rounded-lg border border-nq-border/40 bg-nq-surface p-1 shadow-nq-card",
              !showExpanded
                ? "bottom-2 left-[calc(100%+0.5rem)] w-60"
                : "bottom-[calc(100%-0.25rem)] left-2 right-2",
            )}
          >
            {/* Identity header */}
            <div className="flex items-center gap-3 px-2 py-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nq-primary/20 text-xs font-semibold text-nq-primary">
                {userEmail?.charAt(0).toUpperCase() ?? "U"}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-nq-foreground">
                  {userEmail ?? "User"}
                </p>
                <p className="truncate text-xs text-nq-muted">
                  {localizedRoleLabel(role, roleLabels)}
                </p>
              </div>
            </div>

            {/* Salons — current (✓) + others to switch. Only when >1 salon. */}
            {showSwitcher ? (
              <>
                <div className="my-1 border-t border-nq-border/30" />
                <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                  {t.switchSalon}
                </p>
                <ul className="flex flex-col gap-0.5">
                  <li>
                    <div className="flex min-h-9 items-center gap-3 rounded-md px-2 py-1.5 text-sm text-nq-foreground">
                      <SalonAvatar salonName={salonName} />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {salonName}
                      </span>
                      <Check
                        className="h-4 w-4 shrink-0 text-nq-primary"
                        aria-hidden
                      />
                    </div>
                  </li>
                  {otherSalons.map((s) => (
                    <li key={s.id}>
                      <Link
                        href={`/dashboard/${encodeURIComponent(s.slug)}/center`}
                        role="menuitem"
                        onClick={() => setUserMenuOpen(false)}
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
              </>
            ) : null}

            {/* Language — switches every surface (UI + server + AI) in lockstep */}
            <div className="my-1 border-t border-nq-border/30" />
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {language === "vi" ? "Ngôn ngữ" : "Language"}
              </span>
              <GlobalLanguageToggle />
            </div>

            {/* Sign out */}
            <div className="my-1 border-t border-nq-border/30" />
            <div className="px-2 py-1">
              <LogoutButton language={language} />
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function SidebarMoreSection({
  items,
  pathname,
  collapsed,
  label,
}: {
  items: NavItem[];
  pathname: string;
  collapsed: boolean;
  label: string;
}) {
  const active = items.some((item) => item.href && item.match(pathname));

  return (
    <details className="group" open={active || undefined}>
      <summary
        className={cn(
          "flex min-h-11 w-full cursor-pointer list-none touch-manipulation items-center gap-3 rounded-lg text-nq-muted transition-colors",
          "hover:bg-nq-surface/80 hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
          "[&::-webkit-details-marker]:hidden",
          collapsed ? "px-3" : "px-2.5",
          active ? "bg-nq-primary/15 text-nq-primary" : "",
        )}
        title={collapsed ? label : undefined}
      >
        <Ellipsis className="h-5 w-5 shrink-0" aria-hidden />
        {collapsed ? null : (
          <>
            <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
            <ChevronDown
              className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180"
              aria-hidden
            />
          </>
        )}
      </summary>
      <ul className="mt-1 flex flex-col gap-1 border-l border-nq-border/30 pl-1.5">
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
    </details>
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
  admin: string;
  senior: string;
  nail_tech: string;
  receptionist: string;
};

function localizedRoleLabel(role: string, labels: RoleBadgeMap): string {
  if (role === "owner") return labels.owner;
  if (role === "admin") return labels.admin;
  if (role === "senior") return labels.senior;
  if (role === "receptionist") return labels.receptionist;
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
