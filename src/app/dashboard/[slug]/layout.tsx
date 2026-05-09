import { type ReactNode } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { loadOwnerSalons } from "@/shared/dashboard/salonOwnerActions";

type Props = {
  children: ReactNode;
  params: Promise<{ slug: string }>;
};

/**
 * App-shell for `/dashboard/[slug]/*`. Resolves salon membership once
 * here so each child page doesn't re-fetch the role + salon name for
 * the sidebar. Pages still gate access independently — if a request
 * has no membership the layout renders bare children and the page's
 * own auth guard performs the redirect (keeps redirect targets per-
 * page rather than centralising them here).
 *
 * For owners, also pre-fetches the list of salons the user owns so
 * the sidebar footer can render a switcher dropdown without an extra
 * client-side roundtrip. Skipped for non-owners (the switcher is
 * owner-only — see `loadOwnerSalons` doc).
 */
export default async function DashboardSlugLayout({
  children,
  params,
}: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);

  if (!ctx) {
    // No auth / no membership / demo-gate failed — let the child page
    // perform its own redirect (e.g. to /register or /choose-salon).
    return <>{children}</>;
  }

  const salonName = (ctx.salon.name ?? "").trim() || slug;

  const salons =
    ctx.role === "owner" ? await loadOwnerSalons(slug) : [];

  return (
    <DashboardShell
      slug={slug}
      role={ctx.role}
      salonName={salonName}
      salons={salons}
    >
      {children}
    </DashboardShell>
  );
}
