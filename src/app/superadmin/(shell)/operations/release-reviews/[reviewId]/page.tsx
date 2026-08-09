import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { createClient } from "@/shared/lib/supabase/server";
import { getSuperAdminRole } from "@/shared/lib/superadmin";
import { resolveUserLanguage } from "@/shared/i18n/user/resolveUserLanguage";
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

  const [{ reviewId }, query, language] = await Promise.all([
    params,
    searchParams,
    resolveUserLanguage(),
  ]);
  const review = await loadReleaseReviewById(reviewId);
  if (!review) notFound();

  const decision: ReleaseReviewDecision =
    query.intent === "declined" ? "declined" : "approved";
  const done = query.done === "1";
  const error = typeof query.error === "string" ? query.error : null;
  const alreadyDecided = review.status !== "pending";
  const approving = decision === "approved";
  const action = confirmReleaseReviewDecision.bind(null, review.id, decision);
  const vi = language === "vi";

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8">
      <section className="rounded-2xl border border-nq-border/45 bg-nq-surface/50 p-6 md:p-8">
        <p className="text-xs font-semibold tracking-[0.18em] text-nq-muted uppercase">
          {vi ? "Superadmin · Xem trước thông báo" : "Superadmin · Notice preview"}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-nq-foreground">
          {done || alreadyDecided
            ? review.status === "declined"
              ? vi ? "Đã chọn không thông báo" : "No notice will be prepared"
              : vi ? "Sẵn sàng chuẩn bị thông báo" : "Ready to prepare the notice"
            : approving
              ? vi ? "Tạo nội dung thông báo cho salon?" : "Prepare a notice for salon owners?"
              : vi ? "Không cần thông báo cho salon?" : "No salon notice needed?"}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-nq-muted">
          {vi
            ? "Bản cập nhật đã hoạt động. Lựa chọn này chỉ quyết định có tạo nội dung thông báo cho salon hay không."
            : "The update is already active. This choice only decides whether NailIQ prepares a salon notice."}
        </p>

        <div className="mt-5 rounded-xl border border-nq-border/40 bg-nq-bg/55 p-4">
          <p className="text-xs text-nq-muted">
            {vi ? "Ghi chú nội bộ về thay đổi" : "Internal change note"}
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
            {vi
              ? `Không thể lưu quyết định (${error}). Không có thông báo nào được gửi.`
              : `We could not save the choice (${error}). Nothing was sent.`}
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
                ? vi ? "Có, tạo nội dung để tôi xem" : "Yes, prepare content for review"
                : vi ? "Không cần thông báo" : "No notice needed"}
            </Button>
          </form>
        ) : (
          <p className="mt-5 text-sm text-nq-muted" role="status">
            {vi
              ? "Lựa chọn đã được lưu. NailIQ chưa tự gửi email hay đăng thông báo cho salon."
              : "Your choice was saved. NailIQ has not emailed or published anything to salons."}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-4 text-sm">
          {alreadyDecided && review.status === "approved" ? (
            <Link
              href={`/superadmin/operations/announcements?release=${encodeURIComponent(review.deploymentId)}`}
              className="font-semibold text-nq-primary hover:underline"
            >
              {vi ? "Xem nội dung trước khi gửi" : "Review content before sending"}
            </Link>
          ) : null}
          <Link
            href="/superadmin/dashboard"
            className="text-nq-muted hover:text-nq-foreground hover:underline"
          >
            {vi ? "Về Superadmin" : "Back to Superadmin"}
          </Link>
        </div>
      </section>
    </main>
  );
}
