"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/lib/cn";
import type { SuperAdminRole } from "@/shared/lib/superadmin";
import {
  SUPERADMIN_MOBILE_TABS,
  SUPERADMIN_NAV,
  canReach,
  isPlaceholder,
} from "@/shared/superadmin/nav";

type Props = {
  role: SuperAdminRole;
};

/**
 * Mobile bottom-tab fallback for `/superadmin/*` per
 * `docs/DASHBOARD_LAYOUT_RULES.md` §10.2. 5 fixed tabs below the `md`
 * breakpoint; hidden at `md` and wider where the sidebar takes over.
 *
 * Tabs follow the same disabled/role-aware rules as the sidebar
 * (§10.3) — placeholder tabs render as `<span>` with the phase label
 * hidden behind a tooltip / aria-disabled state.
 */
export function SuperadminBottomNav({ role }: Props) {
  const pathname = usePathname();
  const tabs = SUPERADMIN_MOBILE_TABS.map((key) =>
    SUPERADMIN_NAV.find((item) => item.key === key),
  ).filter((item): item is (typeof SUPERADMIN_NAV)[number] => Boolean(item));

  return (
    <nav
      data-testid="superadmin-bottom-nav"
      className="fixed inset-x-0 bottom-0 z-40 flex h-14 items-stretch border-t border-nq-border bg-nq-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {tabs.map((item) => {
        const isActive =
          pathname === item.href ||
          (pathname?.startsWith(`${item.href}/`) ?? false);
        const roleAllowed = canReach(item, role);
        const phaseDisabled = isPlaceholder(item);
        const disabled = !roleAllowed || phaseDisabled;

        const base =
          "flex flex-1 flex-col items-center justify-center px-1 text-[11px] font-medium";

        if (disabled) {
          return (
            <span
              key={item.key}
              aria-disabled="true"
              data-testid={`superadmin-bottom-${item.key}`}
              data-disabled="true"
              className={cn(base, "text-nq-muted/50")}
            >
              <span className="truncate">{item.label}</span>
            </span>
          );
        }

        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            data-testid={`superadmin-bottom-${item.key}`}
            data-active={isActive ? "true" : "false"}
            className={cn(
              base,
              isActive ? "text-nq-primary" : "text-nq-muted",
            )}
          >
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
