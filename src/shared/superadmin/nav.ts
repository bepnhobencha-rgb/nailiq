import {
  SUPERADMIN_ROLES,
  type SuperAdminRole,
} from "@/shared/lib/superadmin";

/**
 * Sidebar / bottom-nav contract for `/superadmin/*`.
 *
 * Single source of truth for: order, label, href, phase-label
 * (disabled-with-roadmap), and role-aware reach. Per
 * `docs/DASHBOARD_LAYOUT_RULES.md` §10.3-10.4 and
 * `docs/PERMISSION_MATRIX.md` §8.6.
 *
 * Adding a new section means adding an entry here AND a placeholder
 * page under `src/app/superadmin/(shell)/<slug>/page.tsx`. Keep the
 * two in sync; the route file is what makes the link resolve.
 *
 * Phase labels MUST be concrete (e.g. "Coming Phase 2", "Coming
 * Q3 2026"). Vague "Coming Soon" is explicitly forbidden by §10.3.
 */

export type SuperadminNavItem = {
  /** Stable key for active-route + test-id matching. */
  key: string;
  label: string;
  href: string;
  /**
   * When set, the item is rendered disabled with this label visible
   * in tooltip/inline. `undefined` = active route (real content).
   */
  phaseLabel?: string;
  /** Roles permitted to navigate to this section. */
  allowedRoles: readonly SuperAdminRole[];
};

const ALL_ROLES: readonly SuperAdminRole[] = SUPERADMIN_ROLES;

export const SUPERADMIN_NAV: readonly SuperadminNavItem[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    href: "/superadmin/dashboard",
    allowedRoles: ALL_ROLES,
  },
  {
    key: "salons",
    label: "Salons",
    href: "/superadmin/salons",
    allowedRoles: ["founder", "ops_admin", "support_admin", "billing_admin"],
  },
  {
    key: "operations",
    label: "Operations",
    href: "/superadmin/operations",
    phaseLabel: "Coming Phase 2",
    allowedRoles: ["founder", "ops_admin"],
  },
  {
    key: "support",
    label: "Support",
    href: "/superadmin/support",
    allowedRoles: [
      "founder",
      "ops_admin",
      "support_admin",
      "readonly_analyst",
    ],
  },
  {
    key: "analytics",
    label: "Analytics",
    href: "/superadmin/analytics",
    phaseLabel: "Coming Phase 3",
    allowedRoles: ALL_ROLES,
  },
  {
    key: "ai",
    label: "AI Ops",
    href: "/superadmin/ai",
    phaseLabel: "Coming Phase 3",
    allowedRoles: ["founder", "ai_admin"],
  },
  {
    key: "billing",
    label: "Billing",
    href: "/superadmin/billing",
    phaseLabel: "Coming Phase 2",
    allowedRoles: ["founder", "billing_admin"],
  },
  {
    key: "security",
    label: "Security",
    href: "/superadmin/security",
    phaseLabel: "Coming Phase 2",
    allowedRoles: ["founder", "ops_admin"],
  },
  {
    key: "settings",
    label: "Settings",
    href: "/superadmin/settings",
    phaseLabel: "Coming Phase 1F",
    allowedRoles: ALL_ROLES,
  },
];

/**
 * 5 primary tabs for the mobile bottom-tab fallback (per §10.2). Order
 * matches reception priority: Dashboard, Salons, then the most-used
 * cross-tenant surfaces. Settings is included because superadmin-user
 * management lives there and ops cannot work without occasional access.
 */
export const SUPERADMIN_MOBILE_TABS: readonly string[] = [
  "dashboard",
  "salons",
  "operations",
  "support",
  "settings",
];

export function canReach(
  item: SuperadminNavItem,
  role: SuperAdminRole,
): boolean {
  return item.allowedRoles.includes(role);
}

export function isPlaceholder(item: SuperadminNavItem): boolean {
  return typeof item.phaseLabel === "string" && item.phaseLabel.length > 0;
}
