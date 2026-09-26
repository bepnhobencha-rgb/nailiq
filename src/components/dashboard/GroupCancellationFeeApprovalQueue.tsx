"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import {
  decideGroupCancellationFeeReview,
  type GroupCancellationFeeReviewQueueItem,
} from "@/shared/noshow/groupCancellationFeeApprovalActions";
import { dispatchApprovedCancellationFee } from "@/shared/noshow/cancellationFeeDispatchActions";

import { FeeCollectionConfirmation, feePaymentStatusLabel, useFeeQueueMutation } from "./FeeCollectionConfirmation";

function formatUtcMinute(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`
    : iso;
}

export function GroupCancellationFeeApprovalQueue({
  slug,
  salonId,
  items,
}: {
  slug: string;
  salonId: string;
  items: GroupCancellationFeeReviewQueueItem[];
}) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [confirmation, setConfirmation] = useState<{ item: GroupCancellationFeeReviewQueueItem; amount: string } | null>(null);
  const { pendingId, message, unconfirmedIds, run } = useFeeQueueMutation(vi, () => router.refresh());
  if (items.length === 0) return null;

  async function decide(item: GroupCancellationFeeReviewQueueItem, action: "charge" | "waive") {
    const reviewId = item.reviewId;
    if (!reviewId) return;
    await run(reviewId, () => decideGroupCancellationFeeReview(slug, { salonId, reviewId, action }),
      action === "charge"
        ? vi ? "Đã duyệt. Chưa gửi lệnh thanh toán; Thu là bước riêng." : "Approved. No payment was sent. Collection is a separate step."
        : vi ? "Đã miễn phí và lưu biên nhận." : "Waived with a receipt.");
  }

  async function collectConfirmed() {
    if (!confirmation?.item.reviewId) return;
    const { item, amount } = confirmation;
    const reviewId = item.reviewId!;
    const accepted = await run(reviewId, () => dispatchApprovedCancellationFee(slug, {
      salonId, reviewId, reviewKind: "group",
    }), vi ? `Đã thu thành công ${amount}; đã lưu biên nhận.` : `${amount} collected; provider receipt recorded.`, true);
    if (accepted) setConfirmation(null);
  }

  return (
    <section data-testid="group-cancellation-fee-approval-queue" className="mt-4 rounded-2xl border border-amber-300/60 bg-nq-surface p-4">
      <h2 className="text-sm font-semibold text-nq-text">
        {vi ? "Duyệt phí huỷ nhóm" : "Group cancellation fee approvals"}
      </h2>
      <p className="mt-1 text-xs leading-5 text-nq-muted">
        {vi
          ? "Mỗi nhóm chỉ có một phiếu phí. Duyệt Thu chỉ lưu phê duyệt; không gọi Square và không thu tiền."
          : "Each party has one fee record. Approve only records authorization; it does not call Square or collect money."}
      </p>
      <div className="mt-3 space-y-3">
        {items.map((item) => {
          const busy = pendingId !== null;
          const amount = new Intl.NumberFormat(vi ? "vi-VN" : "en-CA", {
            style: "currency",
            currency: item.currency,
          }).format(item.amountCents / 100);
          return (
            <article key={item.reviewId} className="rounded-xl border border-nq-border/40 bg-nq-bg/50 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-nq-text">{item.clientName} · {item.groupSize} {vi ? "người" : "guests"}</p>
                  <p className="text-xs text-nq-muted">{item.serviceName} · {formatUtcMinute(item.startTimeUtc)}</p>
                </div>
                <p className="text-sm font-bold tabular-nums text-nq-warning">{amount}</p>
              </div>
              <p className="mt-2 text-xs text-nq-muted">{item.cardBrand} •••• {item.cardLast4} · {vi ? "Chính sách" : "Policy"}: {item.consentPolicyVersion.slice(0, 16)}…</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {item.state === "pending_review" ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => void decide(item, "charge")} className="min-h-11 rounded-lg border border-nq-warning/50 px-3 py-1.5 text-xs font-semibold text-nq-warning disabled:opacity-50">
                      {vi ? `Duyệt phí ${amount}` : `Approve ${amount}`}
                    </button>
                    <button type="button" disabled={busy} onClick={() => void decide(item, "waive")} className="min-h-11 rounded-lg border border-nq-border px-3 py-1.5 text-xs font-semibold text-nq-muted disabled:opacity-50">
                      {vi ? "Miễn phí" : "Waive"}
                    </button>
                  </>
                ) : item.state === "approved_charge" && item.paymentStatus === "dispatch_blocked" && !unconfirmedIds.has(item.reviewId ?? "") ? (
                  <button type="button" disabled={busy} onClick={() => setConfirmation({ item, amount })} className="min-h-11 rounded-lg border border-nq-warning/50 px-3 py-1.5 text-xs font-semibold text-nq-warning disabled:opacity-50">
                    {vi ? `Thu ${amount}` : `Collect ${amount}`}
                  </button>
                ) : (
                  <span className="rounded-full border border-nq-border px-2 py-1 text-xs text-nq-muted">{unconfirmedIds.has(item.reviewId ?? "") && item.paymentStatus === "dispatch_blocked"
                      ? vi ? "Kết quả chưa rõ — tải lại để kiểm tra" : "Result unconfirmed — reload to check"
                      : feePaymentStatusLabel(item.state, item.paymentStatus, vi)}</span>
                )}
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
        kind="group"
        vi={vi}
        busy={pendingId !== null}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void collectConfirmed()}
      />
    </section>
  );
}
