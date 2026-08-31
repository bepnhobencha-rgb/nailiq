"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import {
  decideGroupCancellationFeeReview,
  type GroupCancellationFeeReviewQueueItem,
} from "@/shared/noshow/groupCancellationFeeApprovalActions";
import { dispatchApprovedCancellationFee } from "@/shared/noshow/cancellationFeeDispatchActions";

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
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (items.length === 0) return null;

  async function decide(item: GroupCancellationFeeReviewQueueItem, action: "charge" | "waive") {
    setPendingId(item.reviewId);
    setMessage(null);
    const result = await decideGroupCancellationFeeReview(slug, {
      salonId,
      reviewId: item.reviewId,
      action,
    });
    setPendingId(null);
    setMessage(result.ok
      ? action === "charge"
        ? vi ? "Đã duyệt phí. Chưa gửi lệnh thu tiền; payment dispatch vẫn bị khóa." : "Fee approved. No payment was sent; payment dispatch remains blocked."
        : vi ? "Đã miễn phí và lưu biên nhận bất biến." : "Fee waived with an immutable receipt."
      : result.error);
    if (result.ok) router.refresh();
  }

  async function collect(item: GroupCancellationFeeReviewQueueItem, amount: string) {
    const confirmed = window.confirm(vi
      ? `Thu đúng ${amount} từ thẻ người tổ chức •••• ${item.cardLast4}? Hành động này có thể chuyển tiền thật.`
      : `Collect exactly ${amount} from organizer card •••• ${item.cardLast4}? This may move real money.`);
    if (!confirmed) return;
    setPendingId(item.reviewId);
    setMessage(null);
    const result = await dispatchApprovedCancellationFee(slug, {
      salonId,
      reviewId: item.reviewId,
      reviewKind: "group",
    });
    setPendingId(null);
    setMessage(result.ok
      ? vi ? "Đã thu phí và nhận biên nhận nhà cung cấp." : "Fee collected with a provider receipt."
      : result.error);
    router.refresh();
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
          const busy = pendingId === item.reviewId;
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
                ) : item.state === "approved_charge" && item.paymentStatus === "dispatch_blocked" ? (
                  <button type="button" disabled={busy} onClick={() => void collect(item, amount)} className="min-h-11 rounded-lg border border-nq-warning/50 px-3 py-1.5 text-xs font-semibold text-nq-warning disabled:opacity-50">
                    {vi ? `Thu ${amount}` : `Collect ${amount}`}
                  </button>
                ) : (
                  <span className="rounded-full border border-nq-border px-2 py-1 text-xs text-nq-muted">{item.state} · {item.paymentStatus}</span>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {message ? <p className="mt-3 text-xs text-nq-muted" role="status">{message}</p> : null}
    </section>
  );
}
