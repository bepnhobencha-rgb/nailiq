import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ReportsPanel } from "@/components/dashboard/ReportsPanel";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { userEn } from "@/shared/i18n/user";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Reports · ${slug}`,
    robots: "noindex",
  };
}

export default async function ReportsPage({ params }: PageProps) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }
  // Owner-only per PERMISSION_MATRIX §3 (reporting + export rows
  // restrict revenue aggregates to owner). Non-owner viewers bounce
  // back to the dashboard home rather than seeing a forbidden screen.
  if (ctx.role !== "owner") {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  return (
    <main className="mx-auto w-full max-w-[var(--max-nq-desktop)] px-[var(--pad-nq-section-mobile)] py-6 md:px-6">
      <h1 className="mb-4 text-xl font-semibold text-nq-foreground">
        {userEn.receptionist.reports.pageTitle}
      </h1>
      <ReportsPanel slug={slug} messages={userEn.receptionist.reports} />
    </main>
  );
}
