import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ReportsPanel } from "@/components/dashboard/ReportsPanel";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { parseCurrency } from "@/shared/lib/currencyFormat";
import { getEffectivePlanLimits } from "@/shared/lib/subscriptionPlans";
import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";

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
  // Reports = the manager KPI/revenue overview → owner + admin. Other roles
  // bounce home rather than seeing a forbidden screen.
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  // P0.2 — pull salon currency + plan fields. One SELECT, two
  // columns: currency for the reports panel; subscription/override
  // for the Studio-tier staff-performance gate.
  const { data: salonRow } = await ctx.supabase
    .from("salons")
    .select(
      "currency_code, subscription_plan, plan_override, feature_flags" as never,
    )
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const planFields = (salonRow ?? {}) as {
    currency_code?: unknown;
    subscription_plan?: string | null;
    plan_override?: string | null;
    feature_flags?: Record<string, unknown> | null;
  };
  // Release flag `advanced_reports` (per-salon) AND platform kill-switch gate
  // the page. notFound() refuses direct-URL access when disabled.
  if (!(await isReleaseFeatureVisible(planFields, "advanced_reports"))) {
    notFound();
  }

  const currency = parseCurrency(planFields.currency_code);
  const hasStaffPerformance =
    getEffectivePlanLimits(planFields).hasStaffPerformance;
  return (
    <main className="mx-auto w-full max-w-[var(--max-nq-desktop)] px-[var(--pad-nq-section-mobile)] py-6 md:px-6">
      <ReportsPanel
        slug={slug}
        currency={currency}
        hasStaffPerformance={hasStaffPerformance}
      />
    </main>
  );
}
