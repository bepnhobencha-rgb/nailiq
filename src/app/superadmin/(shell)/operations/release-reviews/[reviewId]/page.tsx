import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { createClient } from "@/shared/lib/supabase/server";
import { getSuperAdminRole } from "@/shared/lib/superadmin";
import { confirmReleaseReviewDecision } from "@/shared/superadmin/releaseReviewActions";
import { loadReleaseReviewById } from "@/shared/superadmin/releaseReviewStore";
import type { ReleaseReviewDecision } from "@/shared/superadmin/releaseReviewTypes";

export const dynamic = "force-dynamic";

export default async function ReleaseReviewDecisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ reviewId: string }>;
  searchParams: Promise<{
    intent?: string | string[];
    done?: string | string[];
    error?: string | string[];
  }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();
  const role = await getSuperAdminRole(user.id);
  if (!role || !["founder", "ops_admin"].includes(role)) notFound();

  const [{ reviewId }, query] = await Promise.all([params, searchParams]);
  const review = await loadReleaseReviewById(reviewId);
  if (!review) notFound();

  const decision: ReleaseReviewDecision =
    query.intent === "declined" ? "declined" : "approved";
  const done = query.done === "1";
  const error = typeof query.error === "string" ? query.error : null;
  const alreadyDecided = review.status !== "pending";
  const approving = decision === "approved";
  const action = confirmReleaseReviewDecision.bind(null, review.id, decision);

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8">
      <section className="rounded-2xl border border-nq-border/45 bg-nq-surface/50 p-6 md:p-8">
        <p className="text-xs font-semibold tracking-[0.18em] text-nq-muted uppercase">
          Superadmin · Release Review
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-nq-foreground">
          {done || alreadyDecided
            ? review.status === "declined"
              ? "Không cần thông báo"
              : "Bản cập nhật đã được duyệt"
            : approving
              ? "Duyệt để mở bản nháp?"
              : "Xác nhận không cần thông báo?"}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-nq-muted">
          Mở liên kết trong email chưa làm thay đổi dữ liệu. Đây là bước xác nhận
          cuối trong Superadmin.
        </p>

        <div className="mt-5 rounded-xl border border-nq-border/40 bg-nq-bg/55 p-4">
          <p className="text-xs text-nq-muted">
            Commit {review.deploymentId.slice(0, 8)}
          </p>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-nq-foreground">
            {review.changeSummary}
          </p>
        </div>

        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
          >
            Không thể lưu quyết định ({error}). Không có thông báo nào được gửi.
          </p>
        ) : null}

        {!alreadyDecided ? (
          <form action={action} className="mt-6">
            <Button
              type="submit"
              variant={approving ? "primary" : "danger"}
              size="lg"
              fullWidth
            >
              {approving
                ? "Xác nhận duyệt và mở bản nháp"
                : "Xác nhận không cần thông báo"}
            </Button>
          </form>
        ) : (
          <p className="mt-5 text-sm text-nq-muted" role="status">
            Quyết định đã được lưu. Không có email hay thông báo salon nào được
            gửi tự động.
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-4 text-sm">
          {alreadyDecided && review.status === "approved" ? (
            <Link
              href={`/superadmin/operations/announcements?release=${encodeURIComponent(review.deploymentId)}`}
              className="font-semibold text-nq-primary hover:underline"
            >
              Mở bản nháp
            </Link>
          ) : null}
          <Link
            href="/superadmin/dashboard"
            className="text-nq-muted hover:text-nq-foreground hover:underline"
          >
            Về Superadmin
          </Link>
        </div>
      </section>
    </main>
  );
}
