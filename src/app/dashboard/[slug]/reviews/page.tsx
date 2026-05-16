import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { loadSalonReviews } from "@/shared/dashboard/loadSalonReviewsAction";
import { getEffectivePlanLimits } from "@/shared/lib/subscriptionPlans";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Đánh giá · ${slug}`,
    robots: "noindex",
  };
}

/**
 * Owner-only reviews list. Pro+ feature — Free salons see the
 * upsell card via the plan-gate copy below.
 */
export default async function SalonReviewsPage({ params }: PageProps) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  if (ctx.role !== "owner") redirect(`/dashboard/${encodeURIComponent(slug)}`);

  const { data: planRow } = await ctx.supabase
    .from("salons")
    .select("subscription_plan, plan_override, feature_flags" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const planFields = (planRow ?? {}) as {
    subscription_plan?: string | null;
    plan_override?: string | null;
    feature_flags?: Record<string, unknown> | null;
  };
  const hasAutoReviewRequest =
    getEffectivePlanLimits(planFields).hasAutoReviewRequest;

  if (!hasAutoReviewRequest) {
    return (
      <main className="mx-auto w-full max-w-3xl px-5 py-8 md:px-8">
        <header className="flex flex-col gap-2 pb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
            Đánh giá khách hàng
          </h1>
        </header>
        <div className="flex flex-col gap-3 rounded-xl border border-nq-primary/30 bg-nq-primary/10 px-4 py-4">
          <p className="text-sm font-semibold text-nq-foreground">
            Tự động xin đánh giá — gói Pro
          </p>
          <p className="text-sm text-nq-muted">
            Khi lịch hẹn hoàn tất, NailIQ tự gửi email mời khách đánh
            giá. Bạn theo dõi điểm trung bình và nhận xét tại đây.
            Tính năng có trong gói Pro.
          </p>
          <div>
            <a
              href={`/dashboard/${encodeURIComponent(slug)}/settings`}
              className="inline-flex items-center justify-center rounded-full bg-nq-primary px-4 py-2 text-sm font-semibold text-nq-bg hover:opacity-90"
            >
              Nâng cấp Pro
            </a>
          </div>
        </div>
      </main>
    );
  }

  const result = await loadSalonReviews(slug);

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-3xl px-5 py-8 md:px-8">
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          Đánh giá khách hàng
        </h1>
        <p className="mt-6 rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          {result.error === "forbidden"
            ? "Chỉ chủ tiệm xem được trang này."
            : "Không tải được. Thử lại sau."}
        </p>
      </main>
    );
  }

  const avg =
    result.rows.length > 0
      ? result.rows.reduce((sum, r) => sum + (r.rating ?? 0), 0) /
        result.rows.length
      : null;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-8 md:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          Đánh giá khách hàng
        </h1>
        <p className="text-sm text-nq-muted">
          {result.rows.length === 0
            ? "Chưa có đánh giá nào — tiệm sẽ tự gửi email mời khách sau mỗi lần hẹn hoàn tất."
            : `${result.rows.length} đánh giá · ${avg != null ? avg.toFixed(1) : "—"} sao trung bình`}
        </p>
      </header>

      {result.rows.length === 0 ? null : (
        <div className="overflow-x-auto rounded-2xl border border-nq-border/40 bg-nq-surface/40">
          <table
            className="w-full min-w-[600px] text-sm"
            data-testid="reviews-table"
          >
            <thead className="bg-nq-bg/40 text-left text-xs uppercase tracking-wide text-nq-muted">
              <tr>
                <th className="border-b border-nq-border/40 px-4 py-2.5">
                  Khi
                </th>
                <th className="border-b border-nq-border/40 px-4 py-2.5">
                  Sao
                </th>
                <th className="border-b border-nq-border/40 px-4 py-2.5">
                  Dịch vụ
                </th>
                <th className="border-b border-nq-border/40 px-4 py-2.5">
                  Thợ
                </th>
                <th className="border-b border-nq-border/40 px-4 py-2.5">
                  Lời nhắn
                </th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-nq-border/20 align-top"
                >
                  <td className="border-b border-nq-border/20 px-4 py-3 align-top font-mono text-xs text-nq-muted">
                    {r.submittedAt
                      ? new Date(r.submittedAt)
                          .toISOString()
                          .replace("T", " ")
                          .slice(0, 16) + " UTC"
                      : "—"}
                  </td>
                  <td
                    className="border-b border-nq-border/20 px-4 py-3 align-top text-nq-foreground"
                    style={{ color: "#d4af37" }}
                  >
                    {"★".repeat(r.rating ?? 0)}
                    {"☆".repeat(5 - (r.rating ?? 0))}
                  </td>
                  <td className="border-b border-nq-border/20 px-4 py-3 align-top text-nq-foreground">
                    {r.serviceName ?? "—"}
                  </td>
                  <td className="border-b border-nq-border/20 px-4 py-3 align-top text-nq-foreground">
                    {r.staffName ?? "—"}
                  </td>
                  <td className="border-b border-nq-border/20 px-4 py-3 align-top text-nq-foreground">
                    {r.message ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
