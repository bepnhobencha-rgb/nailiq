"use client";

import { type ReactNode } from "react";
import { DashboardSidebar } from "@/components/layout/DashboardSidebar";
import { MobileBottomNav } from "@/components/layout/MobileBottomNav";
import { useSidebarCollapsed } from "@/shared/lib/useSidebarCollapsed";
import type { OwnerSalonSummary } from "@/shared/dashboard/salonOwnerActions";

type Props = {
  slug: string;
  role: string;
  salonName: string;
  children: ReactNode;
  /** Optional badge count for the Walk-in Queue nav row. */
  walkinQueueCount?: number;
  /** Optional count of `in_progress` bookings whose end time has
   * passed. Drives the sidebar Walk-in Queue badge color (red when
   * > 0, regardless of `walkinQueueCount`). */
  overdueCount?: number;
  /** Optional badge count for the Messages nav row (placeholder). */
  messagesCount?: number;
  /** Owner-only: salons this user owns; sidebar renders a switcher
   * dropdown when there are 2+. Pass `[]` to disable the switcher. */
  salons?: OwnerSalonSummary[];
};

/**
 * App-shell wrapper for `/dashboard/[slug]/*`. Renders the persistent
 * sidebar (md+) and the mobile bottom-bar (<md), shifting `<main>` so
 * the inner content does not collide with the sidebar.
 *
 * Layout contract:
 *   - Sidebar lives OUTSIDE the Front Desk three-zone main content area.
 *     The receptionist center's staff column / timeline / queue are
 *     unchanged. See DASHBOARD_LAYOUT_RULES §9.
 *   - Sidebar width is published as `--nq-sidebar-w` (15rem expanded,
 *     4rem collapsed). Main consumes the same variable for left padding
 *     so collapse never causes layout shift inside the timeline grid.
 */
export function DashboardShell({
  slug,
  role,
  salonName,
  children,
  walkinQueueCount,
  overdueCount,
  messagesCount,
  salons,
}: Props) {
  // Single hook instance owns the collapse state. We pass both the
  // value AND the toggle to DashboardSidebar so its toggle button
  // mutates the same React state that drives the CSS variable below.
  // Prior bug: each component called useSidebarCollapsed() separately,
  // so the sidebar's button only flipped its OWN state — the Shell's
  // CSS variable never updated and the aside width stayed stuck.
  const { collapsed, toggle } = useSidebarCollapsed();
  const sidebarWidth = collapsed ? "4rem" : "15rem";

  return (
    <div
      className="min-h-dvh bg-nq-bg"
      style={{ ["--nq-sidebar-w" as string]: sidebarWidth }}
    >
      <DashboardSidebar
        slug={slug}
        role={role}
        salonName={salonName}
        walkinQueueCount={walkinQueueCount}
        overdueCount={overdueCount}
        messagesCount={messagesCount}
        salons={salons}
        collapsed={collapsed}
        onToggleCollapsed={toggle}
      />
      <main
        // Padding-left tracks the sidebar width via the CSS variable.
        // Adding a transition makes the grid slide rather than snap
        // when the user toggles collapse — same easing tokens the
        // receptionist motion uses.
        className="min-h-dvh md:pl-[var(--nq-sidebar-w)] pb-16 md:pb-0 transition-[padding-left] duration-[var(--duration-nq-base)] ease-[var(--ease-nq-out)]"
      >
        {children}
      </main>
      <MobileBottomNav slug={slug} walkinQueueCount={walkinQueueCount} />
    </div>
  );
}
