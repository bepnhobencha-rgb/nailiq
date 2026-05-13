import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ReportsPanel } from "@/components/dashboard/ReportsPanel";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { parseCurrency } from "@/shared/lib/currencyFormat";

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

  // P0.2 — pull salon currency for the reports panel. Reads come from
  // `getDashboardWriteClient` ctx which already has the row; one extra
  // SELECT keeps the read scoped to a single column.
  const { data: currencyRow } = await ctx.supabase
    .from("salons")
    .select("currency_code" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const currency = parseCurrency(
    (currencyRow as { currency_code?: unknown } | null)?.currency_code,
  );

  return (
    <main className="mx-auto w-full max-w-[var(--max-nq-desktop)] px-[var(--pad-nq-section-mobile)] py-6 md:px-6">
      <ReportsPanel slug={slug} currency={currency} />
    </main>
  );
}
