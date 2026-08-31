"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import {
  decideLateCancellationFeeReview,
  type LateCancellationFeeReviewQueueItem,
} from "@/shared/noshow/lateCancellationFeeApprovalActions";
import { dispatchApprovedCancellationFee } from "@/shared/noshow/cancellationFeeDispatchActions";

function formatUtcMinute(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`
    : iso;
}

export function LateCancellationFeeApprovalQueue({
  slug,
  salonId,
  items,
}: {
  slug: string;
  salonId: string;
  items: LateCancellationFeeReviewQueueItem[];
}) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (items.length === 0) return null;

  async function decide(
    item: LateCancellationFeeReviewQueueItem,
    action: "charge" | "waive",
  ) {
    setPendingId(item.reviewId);
    setMessage(null);
    const result = await decideLateCancellationFeeReview(slug, {
      salonId,
      reviewId: item.reviewId,
      action,
    });
    setPendingId(null);
    setMessage(result.ok
      ? action === "charge"
        ? vi
          ? "Đã duyệt đúng số tiền. Chưa gửi lệnh thu; bước tiền vẫn bị khóa."
          : "Exact amount approved. No payment was sent; dispatch remains blocked."
        : vi
          ? "Đã miễn phí và lưu biên nhận bất biến."
          : "Fee waived with an immutable receipt."
      : result.error);
    if (result.ok) router.refresh();
  }

  async function collect(
    item: LateCancellationFeeReviewQueueItem,
    amount: string,
  ) {
    const confirmed = window.confirm(vi
      ? `Thu đúng ${amount} từ thẻ •••• ${item.cardLast4}? Hành động này có thể chuyển tiền thật.`
      : `Collect exactly ${amount} from card •••• ${item.cardLast4}? This may move real money.`);
    if (!confirmed) return;
    setPendingId(item.reviewId);
    setMessage(null);
    const result = await dispatchApprovedCancellationFee(slug, {
      salonId,
      reviewId: item.reviewId,
      reviewKind: "late",
    });
    setPendingId(null);
    setMessage(result.ok
      ? vi ? "Đã thu phí và nhận biên nhận nhà cung cấp." : "Fee collected with a provider receipt."
      : result.error);
    router.refresh();
  }

  return (
    <section
      data-testid="late-cancellation-fee-approval-queue"
      className="mt-4 rounded-2xl border border-amber-300/60 bg-nq-surface p-4"
    >
      <h2 className="text-sm font-semibold text-nq-text">
        {vi ? "Duyệt phí hủy trễ" : "Late cancellation fee approvals"}
      </h2>
      <p className="mt-1 text-xs leading-5 text-nq-muted">
        {vi
          ? "Lịch đã hủy riêng. Grace 15 phút và trần 20% đã được kiểm tra; Owner/Admin quyết định Thu hoặc Miễn. Duyệt chưa chuyển tiền."
          : "Cancellation is already committed. The 15-minute grace and 20% cap were checked; Owner/Admin chooses Charge or Waive. Approval does not move money."}
      </p>
      <div className="mt-3 space-y-3">
        {items.map((item) => {
          const busy = pendingId === item.reviewId;
          const amount = new Intl.NumberFormat(vi ? "vi-VN" : "en-CA", {
            style: "currency",
            currency: item.currency,
          }).format(item.amountCents / 100);
          return (
            <article
              key={item.reviewId}
              className="rounded-xl border border-nq-border/40 bg-nq-bg/50 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-nq-text">
                    {item.clientName}
                  </p>
                  <p className="text-xs text-nq-muted">
                    {item.serviceName} · {formatUtcMinute(item.startTimeUtc)}
                  </p>
                </div>
                <p className="text-sm font-bold tabular-nums text-nq-warning">
                  {amount} · {item.feePercent}%
                </p>
              </div>
              <p className="mt-2 text-xs text-nq-muted">
                {item.cardBrand} •••• {item.cardLast4} · {vi ? "Chính sách" : "Policy"}: {item.consentPolicyVersion.slice(0, 16)}…
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {item.state === "pending_review" ? (
                  <>
                    <Button
                      size="md"
                      variant="secondary"
                      loading={busy}
                      onClick={() => void decide(item, "charge")}
                    >
                      {vi ? `Duyệt ${amount}` : `Approve ${amount}`}
                    </Button>
                    <Button
                      size="md"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void decide(item, "waive")}
                    >
                      {vi ? "Miễn phí" : "Waive"}
                    </Button>
                  </>
                ) : item.state === "approved_charge" &&
                    item.paymentStatus === "dispatch_blocked" ? (
                  <Button
                    size="md"
                    variant="secondary"
                    loading={busy}
                    onClick={() => void collect(item, amount)}
                  >
                    {vi ? `Thu ${amount}` : `Collect ${amount}`}
                  </Button>
                ) : (
                  <span className="rounded-full border border-nq-border px-2 py-1 text-xs text-nq-muted">
                    {item.state} · {item.paymentStatus}
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {message ? (
        <p className="mt-3 text-xs text-nq-muted" role="status">{message}</p>
      ) : null}
    </section>
  );
}
