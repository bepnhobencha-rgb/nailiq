"use client";

import { type ReactNode } from "react";
import {
  DashboardSidebar,
  type ReleaseFeatureMap,
} from "@/components/layout/DashboardSidebar";
import { MobileBottomNav } from "@/components/layout/MobileBottomNav";
import { DashboardTopBar } from "@/components/layout/DashboardTopBar";
import { PwaRegister } from "@/components/layout/PwaRegister";
import { DashboardViewControls } from "@/components/layout/DashboardViewControls";
import { AdminCopilot } from "@/components/dashboard/AdminCopilot";
import { PresenceHeartbeat } from "@/components/layout/PresenceHeartbeat";
import { useSidebarCollapsed } from "@/shared/lib/useSidebarCollapsed";
import type { OwnerSalonSummary } from "@/shared/dashboard/salonOwnerActions";
import type { SubscriptionPlan } from "@/shared/lib/subscriptionPlans";

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
  /** Pending Minh approval requests count (owner/admin only). */
  pendingApprovalsCount?: number;
  /** Owner-only: salons this user owns; sidebar renders a switcher
   * dropdown when there are 2+. Pass `[]` to disable the switcher. */
  salons?: OwnerSalonSummary[];
  /** Controls plan-gated sidebar items (e.g. Reviews hidden for free). */
  subscriptionPlan?: SubscriptionPlan;
  /** Server-resolved release-feature visibility for Beta nav items (PR2). */
  releaseFeatures?: ReleaseFeatureMap;
  /** Authenticated user's email address for the user profile card in sidebar footer. */
  userEmail?: string | null;
  /** Salon DB id — passed to PresenceHeartbeat to tag the presence row. */
  salonId?: string | null;
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
  pendingApprovalsCount,
  salons,
  subscriptionPlan,
  releaseFeatures,
  userEmail,
  salonId,
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
      <PwaRegister />
      {salonId && <PresenceHeartbeat salonId={salonId} />}
      <DashboardSidebar
        slug={slug}
        role={role}
        salonName={salonName}
        walkinQueueCount={walkinQueueCount}
        overdueCount={overdueCount}
        messagesCount={messagesCount}
        pendingApprovalsCount={pendingApprovalsCount}
        salons={salons}
        collapsed={collapsed}
        onToggleCollapsed={toggle}
        subscriptionPlan={subscriptionPlan}
        releaseFeatures={releaseFeatures}
        userEmail={userEmail}
      />
      <main
        // Padding-left tracks the sidebar width via the CSS variable.
        // Adding a transition makes the grid slide rather than snap
        // when the user toggles collapse — same easing tokens the
        // receptionist motion uses.
        className="min-h-dvh md:pl-[var(--nq-sidebar-w)] pb-16 md:pb-0 transition-[padding-left] duration-[var(--duration-nq-base)] ease-[var(--ease-nq-out)]"
      >
        <DashboardTopBar slug={slug} />
        {/* The view controls (refresh + fullscreen) live here, fixed top-right
            on every page. Fullscreen now targets the whole document so the
            sidebar/nav + portaled drawers all stay usable. */}
        <div id="nq-dashboard-content">
          <DashboardViewControls />
          {children}
        </div>
      </main>
      <MobileBottomNav
        slug={slug}
        walkinQueueCount={walkinQueueCount}
        overdueCount={overdueCount}
        role={role}
        releaseFeatures={releaseFeatures}
      />
      {/* Coco — in-admin AI assistant. Gated by the admin_copilot release
          feature; nail_tech is view-only so the operational copilot is hidden
          for them. The API route re-checks both (defence in depth). */}
      {releaseFeatures?.admin_copilot && role !== "nail_tech" && (
        <AdminCopilot slug={slug} role={role} />
      )}
    </div>
  );
}
