"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import {
  decideNoShowFeeReview,
  dispatchApprovedNoShowFee,
  requestNoShowFeeReview,
  type NoShowFeeReviewQueueItem,
} from "@/shared/noshow/noShowFeeApprovalActions";

import { FeeCollectionConfirmation, feePaymentStatusLabel, useFeeQueueMutation } from "./FeeCollectionConfirmation";

function formatTime(isoUtc: string): string {
  try {
    return new Date(isoUtc).toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return isoUtc;
  }
}

export function NoShowFeeApprovalQueue({
  slug,
  salonId,
  items,
}: {
  slug: string;
  salonId: string;
  items: NoShowFeeReviewQueueItem[];
}) {
  if (items.length === 0) return null;
  return <NoShowFeeApprovalQueueContent slug={slug} salonId={salonId} items={items} />;
}

function NoShowFeeApprovalQueueContent({
  slug,
  salonId,
  items,
}: {
  slug: string;
  salonId: string;
  items: NoShowFeeReviewQueueItem[];
}) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [confirmation, setConfirmation] = useState<{ item: NoShowFeeReviewQueueItem; amount: string } | null>(null);
  const { pendingId, message, unconfirmedIds, run } = useFeeQueueMutation(vi, () => router.refresh());

  async function request(item: NoShowFeeReviewQueueItem) {
    await run(item.decisionId, () => requestNoShowFeeReview(slug, { salonId, decisionId: item.decisionId }),
      vi ? "Đã tạo phiếu để Owner duyệt." : "Owner review created.");
  }

  async function decide(item: NoShowFeeReviewQueueItem, action: "charge" | "waive") {
    const reviewId = item.reviewId;
    if (!reviewId) return;
    await run(reviewId, () => decideNoShowFeeReview(slug, { salonId, reviewId, action }),
      action === "charge"
        ? vi ? "Đã duyệt. Chưa gửi lệnh thanh toán; Thu là bước riêng." : "Approved. No payment was sent. Collection is a separate step."
        : vi ? "Đã miễn phí và lưu biên nhận." : "Waived with a receipt.");
  }

  async function collectConfirmed() {
    if (!confirmation?.item.reviewId) return;
    const { item, amount } = confirmation;
    const reviewId = item.reviewId!;
    const accepted = await run(reviewId, () => dispatchApprovedNoShowFee(slug, {
      salonId, reviewId,
    }), vi ? `Đã thu thành công ${amount}; đã lưu biên nhận.` : `${amount} collected; provider receipt recorded.`, true);
    if (accepted) setConfirmation(null);
  }

  return (
    <section data-testid="no-show-fee-approval-queue" className="mt-4 rounded-2xl border border-nq-primary/30 bg-nq-surface p-4">
      <h2 className="text-sm font-semibold text-nq-text">
        {vi ? "Duyệt phí no-show" : "No-show fee approvals"}
      </h2>
      <p className="mt-1 text-xs leading-5 text-nq-muted">
        {vi
          ? "No-show đã được xác nhận riêng. AI chỉ gợi ý; Owner/Admin quyết định Thu hoặc Miễn. Duyệt Thu chưa chuyển tiền — bước Thu ngay mới gọi Square."
          : "Attendance is confirmed separately. AI only recommends; Owner/Admin chooses Charge or Waive. Approval does not move money — Collect now is the separate Square action."}
      </p>
      <div className="mt-3 space-y-3">
        {items.map((item) => {
          const busy = pendingId !== null;
          const amount = new Intl.NumberFormat(vi ? "vi-VN" : "en-CA", {
            style: "currency",
            currency: item.currency,
          }).format(item.amountCents / 100);
          return (
            <article key={item.decisionId} data-testid={`no-show-fee-review-${item.decisionId}`} className="rounded-xl border border-nq-border/40 bg-nq-bg/50 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-nq-text">{item.clientName}</p>
                  <p className="text-xs text-nq-muted">{item.serviceName} · {formatTime(item.startTimeUtc)}</p>
                </div>
                <p className="text-sm font-bold tabular-nums text-nq-warning">{amount}</p>
              </div>
              <div className="mt-2 grid gap-1 text-xs text-nq-muted sm:grid-cols-2">
                <span>{item.cardBrand} •••• {item.cardLast4}</span>
                <span>{vi ? "Chính sách" : "Policy"}: {item.consentPolicyVersion.slice(0, 16)}…</span>
                <span>{vi ? "AI gợi ý" : "AI suggestion"}: {item.aiRecommendation}</span>
                <span>{item.aiReasonCodes.join(" · ") || "owner_review_required"}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {item.state === "ready_to_request" ? (
                  <button type="button" disabled={busy} onClick={() => void request(item)} className="rounded-lg bg-nq-primary px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50">
                    {vi ? "Tạo phiếu duyệt" : "Create review"}
                  </button>
                ) : null}
                {item.state === "pending" ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => void decide(item, "charge")} className="rounded-lg border border-nq-warning/50 px-3 py-1.5 text-xs font-semibold text-nq-warning disabled:opacity-50">
                      {vi ? `Duyệt thu ${amount}` : `Approve ${amount}`}
                    </button>
                    <button type="button" disabled={busy} onClick={() => void decide(item, "waive")} className="rounded-lg border border-nq-border px-3 py-1.5 text-xs font-semibold text-nq-muted disabled:opacity-50">
                      {vi ? "Miễn phí" : "Waive"}
                    </button>
                  </>
                ) : item.state === "approved_charge" && item.paymentStatus === "dispatch_blocked" && !unconfirmedIds.has(item.reviewId ?? "") ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmation({ item, amount })}
                    className="min-h-11 rounded-lg bg-nq-warning px-3 py-1.5 text-xs font-bold text-black disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {vi ? `Thu ngay ${amount}` : `Collect ${amount} now`}
                  </button>
                ) : item.state === "approved_charge" && ["dispatching", "pending_provider", "unknown"].includes(item.paymentStatus) ? (
                  <button type="button" disabled className="min-h-11 rounded-lg border border-nq-border px-3 py-1.5 text-xs font-semibold text-nq-muted opacity-70">
                    {vi ? "Đang đối soát — không thử lại" : "Reconciling — do not retry"}
                  </button>
                ) : item.state !== "ready_to_request" ? (
                  <span className="rounded-full border border-nq-border px-2 py-1 text-xs text-nq-muted">
                    {unconfirmedIds.has(item.reviewId ?? "") && item.paymentStatus === "dispatch_blocked"
                      ? vi ? "Kết quả chưa rõ — tải lại để kiểm tra" : "Result unconfirmed — reload to check"
                      : feePaymentStatusLabel(item.state, item.paymentStatus, vi)}
                  </span>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      {message ? <p className="mt-3 text-xs text-nq-muted" role="status">{message}</p> : null}
      <FeeCollectionConfirmation
        isOpen={confirmation !== null}
        amount={confirmation?.amount ?? ""}
        cardBrand={confirmation?.item.cardBrand ?? ""}
        cardLast4={confirmation?.item.cardLast4 ?? ""}
        kind="no-show"
        vi={vi}
        busy={pendingId !== null}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void collectConfirmed()}
      />
    </section>
  );
}
