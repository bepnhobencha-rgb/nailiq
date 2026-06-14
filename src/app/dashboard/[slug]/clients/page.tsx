import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ClientProfilesPanel } from "@/components/dashboard/ClientProfilesPanel";
import { ClientDedupePanel } from "@/components/dashboard/ClientDedupePanel";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { parseClientSegmentSettings } from "@/shared/dashboard/clientSegmentSettings";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Clients · ${slug}`,
    robots: "noindex",
  };
}

export default async function ClientsPage({ params }: PageProps) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }
  // Server-side gate matches loadClientProfiles: desk roles may view client
  // profiles (owner / senior / admin / receptionist). Only nail_tech is
  // bounced — its surface doesn't expose client PII.
  if (
    ctx.role !== "owner" &&
    ctx.role !== "senior" &&
    ctx.role !== "admin" &&
    ctx.role !== "receptionist"
  ) {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  // Per-salon lifecycle thresholds (Admin Settings). NULL row → app defaults.
  const { data: segRow } = await ctx.supabase
    .from("salons")
    .select("client_segment_settings")
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const seg = parseClientSegmentSettings(
    (segRow as { client_segment_settings?: unknown } | null)
      ?.client_segment_settings,
  );

  return (
    <main className="mx-auto w-full max-w-[var(--max-nq-desktop)] px-[var(--pad-nq-section-mobile)] py-6 md:px-6">
      {/* Merge/dedupe is an owner-only cleanup tool (writes across the book). */}
      {ctx.role === "owner" ? <ClientDedupePanel slug={slug} /> : null}
      <ClientProfilesPanel
        slug={slug}
        viewerRole={ctx.role}
        newMaxVisits={seg.newMaxVisits}
        atRiskDays={seg.atRiskDays}
      />
    </main>
  );
}
