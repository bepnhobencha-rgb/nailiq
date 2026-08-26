import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ClientProfilesPanel } from "@/components/dashboard/ClientProfilesPanel";
import { TopHostsPanel } from "@/components/dashboard/TopHostsPanel";
import { TopSpendersPanel } from "@/components/dashboard/TopSpendersPanel";
import { MultiNamePhonePanel } from "@/components/dashboard/MultiNamePhonePanel";
import { ClientIdentityReviewPanel } from "@/components/dashboard/ClientIdentityReviewPanel";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { parseClientSegmentSettings } from "@/shared/dashboard/clientSegmentSettings";
import { loadClientIdentityReview } from "@/shared/dashboard/clientIdentityReviewAction";

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

  // The member-profile RPC returns only the two bounded lifecycle thresholds;
  // unknown/raw management JSON keys never reach desk roles.
  const identityReview = await (
    ctx.role === "owner" || ctx.role === "admin"
      ? loadClientIdentityReview(slug)
      : Promise.resolve(null)
  );
  const seg = parseClientSegmentSettings(
    ctx.salon.client_segment_settings,
  );

  return (
    <main className="mx-auto w-full max-w-[var(--max-nq-desktop)] px-[var(--pad-nq-section-mobile)] py-6 md:px-6">
      {/* Manager insights (owner + admin): top group hosts (click → who they
          brought / when / what) + one-number-many-names cleanup. Front-desk
          roles don't manage customer identity. */}
      {(() => {
        const isManager = ctx.role === "owner" || ctx.role === "admin";
        return isManager ? (
          <>
            {identityReview ? (
              <ClientIdentityReviewPanel
                slug={slug}
                initial={identityReview}
              />
            ) : null}
            <TopSpendersPanel slug={slug} viewerRole={ctx.role} />
            <TopHostsPanel slug={slug} viewerRole={ctx.role} />
            <MultiNamePhonePanel slug={slug} viewerRole={ctx.role} />
          </>
        ) : null;
      })()}
      <ClientProfilesPanel
        slug={slug}
        viewerRole={ctx.role}
        newMaxVisits={seg.newMaxVisits}
        atRiskDays={seg.atRiskDays}
      />
    </main>
  );
}
