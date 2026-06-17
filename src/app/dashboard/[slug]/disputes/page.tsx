import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { DisputesPanel } from "@/components/dashboard/DisputesPanel";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Card Disputes · ${slug}`,
    // Financial data — never index.
    robots: "noindex",
  };
}

/**
 * `/dashboard/[slug]/disputes` — Card Disputes report.
 *
 * Access: owner + admin only. Sensitive financial data; receptionist,
 * senior, and nail_tech roles are bounced back to the dashboard root.
 */
export default async function DisputesPage({ params }: PageProps) {
  const { slug } = await params;

  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }

  // Financial data — restrict to owner + admin.
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  return (
    <main className="mx-auto w-full max-w-[var(--max-nq-desktop)] px-[var(--pad-nq-section-mobile)] py-6 md:px-6">
      <DisputesPanel slug={slug} />
    </main>
  );
}
