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
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const vi = language === "vi";

  async function request(item: NoShowFeeReviewQueueItem) {
    setPendingId(item.decisionId);
    setMessage(null);
    const result = await requestNoShowFeeReview(slug, {
      salonId,
      decisionId: item.decisionId,
    });
    setPendingId(null);
    setMessage(result.ok
      ? vi ? "Đã tạo phiếu để Owner duyệt." : "Owner review created."
      : result.error);
    if (result.ok) router.refresh();
  }

  async function decide(item: NoShowFeeReviewQueueItem, action: "charge" | "waive") {
    if (!item.reviewId) return;
    setPendingId(item.reviewId);
    setMessage(null);
    const result = await decideNoShowFeeReview(slug, {
      salonId,
      reviewId: item.reviewId,
      action,
    });
    setPendingId(null);
    setMessage(result.ok
      ? action === "charge"
        ? vi ? "Đã duyệt. Chưa gửi lệnh thu tiền; cổng phát hành vẫn đang tắt." : "Approved. No payment was sent; release dispatch remains off."
        : vi ? "Đã miễn phí và lưu biên nhận." : "Waived with an immutable receipt."
      : result.error);
    if (result.ok) router.refresh();
  }

  async function dispatch(item: NoShowFeeReviewQueueItem, amount: string) {
    if (!item.reviewId) return;
    const confirmed = window.confirm(vi
      ? `Xác nhận thu ${amount} từ ${item.cardBrand} •••• ${item.cardLast4}. Square sẽ xử lý tiền thật. Thao tác này chống thu trùng.`
      : `Confirm a real ${amount} charge to ${item.cardBrand} •••• ${item.cardLast4}. Square will process real money. Duplicate charges are blocked.`);
    if (!confirmed) return;
    setPendingId(item.reviewId);
    setMessage(null);
    const result = await dispatchApprovedNoShowFee(slug, {
      salonId,
      reviewId: item.reviewId,
    });
    setPendingId(null);
    setMessage(result.ok
      ? vi ? `Đã thu thành công ${amount}; đã lưu biên nhận Square.` : `${amount} collected; Square receipt recorded.`
      : result.error);
    router.refresh();
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
          const busy = pendingId === (item.reviewId ?? item.decisionId);
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
                ) : item.state === "approved_charge" && item.paymentStatus === "dispatch_blocked" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void dispatch(item, amount)}
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
                    {item.state} · {item.paymentStatus}
                  </span>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      {message ? <p className="mt-3 text-xs text-nq-muted" role="status">{message}</p> : null}
    </section>
  );
}
