import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ReportsPanel } from "@/components/dashboard/ReportsPanel";
import { FinancialEvidencePanel } from "@/components/dashboard/FinancialEvidencePanel";
import { Card } from "@/components/ui/Card";
import {
  loadSalonReports,
  type ReportsDateRange,
} from "@/shared/dashboard/loadSalonReports";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { getUserMessages } from "@/shared/i18n/user";
import { resolveUserLanguage } from "@/shared/i18n/user/resolveUserLanguage";
import { parseCurrency } from "@/shared/lib/currencyFormat";
import { getEffectivePlanLimits } from "@/shared/lib/subscriptionPlans";
import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import { salonToday } from "@/shared/lib/salonTime";
import { loadFinancialReport } from "@/shared/reports/loadFinancialReport";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string | string[] }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Insights · ${slug}`,
    robots: "noindex",
  };
}

export default async function ReportsPage({ params, searchParams }: PageProps) {
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

  const planFields = ctx.salon;
  // Keep the disabled state inside the existing dashboard tree. Throwing
  // notFound() after this route's dynamic auth and salon reads caused Next's
  // App Router to violate React's hook-order invariant (#310) in production.
  // The stable state below exposes no report data and avoids a client
  // navigation/404 boundary entirely.
  if (!(await isReleaseFeatureVisible(planFields, "advanced_reports"))) {
    const language = await resolveUserLanguage();
    const messages = getUserMessages(language).receptionist.reports;
    return (
      <main className="mx-auto w-full max-w-[var(--max-nq-desktop)] px-[var(--pad-nq-section-mobile)] py-6 md:px-6">
        <div className="space-y-4" data-testid="insights-disabled">
          <h1 className="text-xl font-semibold text-nq-foreground">
            {messages.pageTitle}
          </h1>
          <Card variant="default" padding="md">
            <p role="status" className="text-sm text-nq-muted">
              {messages.errors.feature_not_enabled}
            </p>
          </Card>
        </div>
      </main>
    );
  }

  const currency = parseCurrency(planFields.currency_code);
  const hasStaffPerformance =
    getEffectivePlanLimits(planFields).hasStaffPerformance;
  const range = parseReportsRange((await searchParams).range);
  const financialRange = financialLocalRange(salonToday(ctx.salon.timezone), range);
  const [result, financialResult, language] = await Promise.all([
    loadSalonReports(slug, range),
    loadFinancialReport(slug, financialRange.from, financialRange.toExclusive),
    resolveUserLanguage(),
  ]);

  return (
    <main className="mx-auto w-full max-w-[var(--max-nq-desktop)] px-[var(--pad-nq-section-mobile)] py-6 md:px-6">
      <ReportsPanel
        slug={slug}
        range={range}
        result={result}
        language={language}
        currency={currency}
        hasStaffPerformance={hasStaffPerformance}
      />
      <div className="mt-4">
        <FinancialEvidencePanel slug={slug} result={financialResult} language={language} />
      </div>
    </main>
  );
}

function financialLocalRange(today: string, range: ReportsDateRange): { from: string; toExclusive: string } {
  const date = new Date(`${today}T00:00:00.000Z`);
  const ymd = (value: Date) => value.toISOString().slice(0, 10);
  if (range === "today") {
    const next = new Date(date); next.setUTCDate(date.getUTCDate() + 1);
    return { from: today, toExclusive: ymd(next) };
  }
  if (range === "week") {
    const monday = new Date(date); monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    const next = new Date(monday); next.setUTCDate(monday.getUTCDate() + 7);
    return { from: ymd(monday), toExclusive: ymd(next) };
  }
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { from: ymd(first), toExclusive: ymd(next) };
}

function parseReportsRange(
  value: string | string[] | undefined,
): ReportsDateRange {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate === "week" || candidate === "month" ? candidate : "today";
}
