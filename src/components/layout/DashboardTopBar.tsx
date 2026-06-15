"use client";

import { usePathname } from "next/navigation";
import { GlobalLanguageToggle } from "@/components/user/GlobalLanguageToggle";

/**
 * Slim mobile-only (<md) top bar that carries the global EN/VI toggle so
 * every phone page can switch language in place — the desktop sidebar
 * footer covers md+. Self-hides on the pages that already render their own
 * in-content toggle (owner home, Front Desk, Owner Pulse) to avoid a
 * duplicate switch.
 */
export function DashboardTopBar({ slug }: { slug: string }) {
  const pathname = usePathname() ?? "";
  const root = `/dashboard/${encodeURIComponent(slug)}`;
  const hasOwnToggle =
    pathname === root ||
    pathname.startsWith(`${root}/center`) ||
    pathname.startsWith(`${root}/pulse`);
  if (hasOwnToggle) return null;

  return (
    <div className="md:hidden sticky top-0 z-30 flex justify-end border-b border-nq-border/30 bg-nq-bg/85 px-4 py-2 backdrop-blur">
      <GlobalLanguageToggle />
    </div>
  );
}
