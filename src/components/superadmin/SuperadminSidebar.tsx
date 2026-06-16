"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/shared/lib/cn";
import type { SuperAdminRole } from "@/shared/lib/superadmin";
import {
  SUPERADMIN_NAV,
  canReach,
  isPlaceholder,
  type SuperadminNavItem,
} from "@/shared/superadmin/nav";
import { SuperadminSignOutButton } from "@/components/superadmin/SuperadminSignOutButton";

const COLLAPSE_KEY = "nailiq-superadmin-sidebar-collapsed";

type Props = {
  role: SuperAdminRole;
};

/**
 * Superadmin app-shell sidebar per `docs/DASHBOARD_LAYOUT_RULES.md` §10.
 *
 * - Geometry: 240px expanded / 64px collapsed.
 * - Persistence: `localStorage[nailiq-superadmin-sidebar-collapsed]`
 *   following the same key convention as §9.4.
 * - Active route: gold accent (`bg-nq-primary/15` + `text-nq-primary`)
 *   on the item whose href is a prefix of `usePathname()`.
 * - Disabled item: `<span>` (not `<a>`) so screen readers don't
 *   announce a fake link; concrete phase label shows inline.
 * - Role-aware: items the current role cannot reach are rendered
 *   disabled with a role tooltip.
 */
export function SuperadminSidebar({ role }: Props) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLLAPSE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR hydration: read localStorage once on mount to restore persisted collapse state
      if (stored === "1") setCollapsed(true);
    } catch {
      // localStorage unavailable (private mode / SSR-only env) — ignore.
    }
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  };

  return (
    <aside
      data-testid="superadmin-sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-nq-border bg-nq-surface md:flex",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <header
        className={cn(
          "flex shrink-0 items-center gap-2 border-b border-nq-border px-3 py-4",
          collapsed && "justify-center px-2",
        )}
      >
        {collapsed ? null : (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="inline-flex items-baseline font-bold tracking-[-0.02em] leading-none text-lg select-none">
              <span className="text-white">Nail</span>
              <span className="text-nq-primary">IQ</span>
            </span>
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-nq-muted">
              SuperAdmin
            </span>
          </div>
        )}
        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggle}
          className={cn(
            "ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg border border-nq-border text-nq-muted transition-colors hover:bg-nq-bg hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
            collapsed && "ml-0",
          )}
          data-testid="superadmin-sidebar-toggle"
        >
          <span aria-hidden="true" className="text-xs">
            {collapsed ? "›" : "‹"}
          </span>
        </button>
      </header>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-2 py-3">
        {SUPERADMIN_NAV.filter((item) => !item.mvpHidden).map((item) => (
          <SidebarItem
            key={item.key}
            item={item}
            pathname={pathname}
            collapsed={collapsed}
            role={role}
          />
        ))}
      </nav>

      <footer
        className={cn(
          "shrink-0 border-t border-nq-border px-3 py-3",
          collapsed ? "flex flex-col items-center gap-2 px-2" : "flex flex-col gap-2",
        )}
      >
        <span
          className={cn(
            "text-[11px] uppercase tracking-[0.12em] text-nq-muted",
            collapsed && "text-center",
          )}
        >
          {collapsed ? role.slice(0, 1).toUpperCase() : `Role: ${role}`}
        </span>
        <SuperadminSignOutButton compact={collapsed} />
      </footer>
    </aside>
  );
}

function SidebarItem({
  item,
  pathname,
  collapsed,
  role,
}: {
  item: SuperadminNavItem;
  pathname: string | null;
  collapsed: boolean;
  role: SuperAdminRole;
}) {
  const isActive =
    pathname === item.href ||
    (pathname?.startsWith(`${item.href}/`) ?? false);
  const roleAllowed = canReach(item, role);
  const phaseDisabled = isPlaceholder(item);
  const disabled = !roleAllowed || phaseDisabled;
  const reason = !roleAllowed
    ? `${role} cannot reach this section`
    : phaseDisabled
      ? item.phaseLabel
      : undefined;

  const baseClasses = cn(
    "group flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
    collapsed && "justify-center px-2",
  );

  if (disabled) {
    return (
      <span
        data-testid={`superadmin-nav-${item.key}`}
        data-disabled="true"
        data-reason={reason ?? ""}
        aria-disabled="true"
        title={collapsed ? `${item.label} — ${reason ?? "disabled"}` : undefined}
        className={cn(
          baseClasses,
          "cursor-not-allowed text-nq-muted/60 opacity-60",
        )}
      >
        <span className={cn("truncate", collapsed && "sr-only")}>
          {item.label}
        </span>
        {!collapsed && reason ? (
          <span className="ml-auto whitespace-nowrap rounded-full bg-nq-bg px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-nq-muted">
            {phaseDisabled ? item.phaseLabel : "Restricted"}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <Link
      href={item.href}
      data-testid={`superadmin-nav-${item.key}`}
      data-active={isActive ? "true" : "false"}
      aria-current={isActive ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      className={cn(
        baseClasses,
        isActive
          ? "bg-nq-primary/15 text-nq-primary"
          : "text-nq-foreground hover:bg-nq-bg",
      )}
    >
      <span className={cn("truncate", collapsed && "sr-only")}>
        {item.label}
      </span>
    </Link>
  );
}
