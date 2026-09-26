"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { formatInSalonTz } from "@/shared/lib/salonTime";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import {
  confirmCancellationFeeFromEmail,
  waiveCancellationFeeFromEmail,
  type loadCancellationFeeEmailReview,
} from "@/shared/noshow/cancellationFeeEmailActions";
import { FeeCollectionConfirmation, feePaymentStatusLabel, useFeeQueueMutation } from "./FeeCollectionConfirmation";

type ReviewData = Extract<Awaited<ReturnType<typeof loadCancellationFeeEmailReview>>, { ok: true }>;
type Review = ReviewData["reviews"][number];

function canCollect(review: Review): boolean {
  const awaitingDecision = review.state === "pending_review" && review.paymentStatus === "not_authorized";
  const approved = review.state === "approved_charge" && review.paymentStatus === "dispatch_blocked";
  return (awaitingDecision || approved) && Number.isSafeInteger(review.amountCents)
    && review.amountCents > 0 && /^[A-Z]{3}$/.test(review.currency)
    && Boolean(review.cardBrand?.trim()) && /^\d{4}$/.test(review.cardLast4)
    && Boolean(review.consentPolicyVersion?.trim());
}

export function CancellationFeeAction({ slug, data }: { slug: string; data: ReviewData }) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const router = useRouter();
  const { pendingId, message, unconfirmedIds, run } = useFeeQueueMutation(vi, () => router.refresh());
  const [confirmation, setConfirmation] = useState<{ review: Review; amount: string; action: "collect" | "waive" } | null>(null);
  const bookingTime = formatInSalonTz(data.startTimeUtc, data.timezone, "datetime", vi ? "vi-VN" : "en-US");

  async function confirm() {
    if (!confirmation || confirmation.action !== "collect") return;
    const { review, amount } = confirmation;
    const accepted = await run(review.reviewId, () => confirmCancellationFeeFromEmail(slug, {
      salonId: data.salonId,
      bookingId: data.bookingId,
      reviewId: review.reviewId,
      reviewKind: review.reviewKind,
      amountCents: review.amountCents,
      currency: review.currency,
      cardBrand: review.cardBrand,
      cardLast4: review.cardLast4,
      consentPolicyVersion: review.consentPolicyVersion,
    }), vi ? `Đã thu ${amount}. Biên nhận đã được lưu.` : `${amount} collected. Receipt recorded.`, true);
    if (accepted) setConfirmation(null);
  }

  async function confirmWaiver() {
    if (!confirmation || confirmation.action !== "waive") return;
    const { review } = confirmation;
    const accepted = await run(review.reviewId, () => waiveCancellationFeeFromEmail(slug, {
      salonId: data.salonId, bookingId: data.bookingId, reviewId: review.reviewId,
      reviewKind: review.reviewKind, amountCents: review.amountCents, currency: review.currency,
    }), vi ? "Đã miễn phí hủy — không thu tiền. Quyết định đã được lưu." : "Cancellation fee waived — no charge. Decision recorded.");
    if (accepted) setConfirmation(null);
  }

  return <section className="mx-auto w-full max-w-xl space-y-4 p-4 sm:p-6" data-testid="cancellation-fee-action">
    <header className="space-y-2">
      <p className="text-sm text-nq-muted">{data.salonName}</p>
      <h1 className="text-xl font-semibold text-nq-text">{vi ? "Xử lý phí hủy lịch" : "Review cancellation fee"}</h1>
      <p className="text-sm text-nq-muted">{vi ? "Mở email hoặc trang này không thu tiền. Chỉ thu khi bạn xác nhận." : "Opening the email or this page does not charge the card. Payment requires your confirmation."}</p>
    </header>
    <Card className="space-y-2">
      <h2 className="font-semibold text-nq-text">{data.clientName}</h2>
      <p className="text-sm text-nq-text">{data.serviceName}</p>
      <p className="text-sm text-nq-muted">{bookingTime}</p>
      <p className="text-xs text-nq-muted">{vi ? "Giờ tại salon" : "Salon time"}: {data.timezone}</p>
    </Card>
    {data.reviews.length === 0 ? <Card>
      <p className="text-sm text-nq-text">{vi ? "Chưa có phiếu phí đủ điều kiện thu cho lịch này. Không tự động thu tiền khi khách hủy." : "No fee is ready for collection for this appointment. Cancellation does not automatically charge the card."}</p>
    </Card> : data.reviews.map((review) => {
      const amount = Number.isSafeInteger(review.amountCents) && /^[A-Z]{3}$/.test(review.currency)
        ? new Intl.NumberFormat(vi ? "vi-VN" : "en-CA", { style: "currency", currency: review.currency, currencyDisplay: "code" }).format(review.amountCents / 100)
        : vi ? "Chưa xác định số tiền" : "Amount unavailable";
      const unconfirmed = unconfirmedIds.has(review.reviewId);
      const eligible = canCollect(review) && !unconfirmed;
      const canWaive = review.state === "pending_review" && review.paymentStatus === "not_authorized"
        && Number.isSafeInteger(review.amountCents) && review.amountCents > 0
        && /^[A-Z]{3}$/.test(review.currency) && !unconfirmed;
      const status = unconfirmed && review.paymentStatus !== "succeeded"
        ? vi ? "Kết quả chưa rõ — tải lại để kiểm tra, không thu lại." : "Result unconfirmed — refresh to check; do not collect again."
        : feePaymentStatusLabel(review.state, review.paymentStatus, vi);
      return <Card key={review.reviewId} className="space-y-3" data-testid="cancellation-fee-review">
        <h2 className="font-semibold text-nq-text">{review.reviewKind === "group" ? vi ? "Phí hủy nhóm" : "Group cancellation fee" : vi ? "Phí hủy trễ" : "Late cancellation fee"}</h2>
        <p className="text-xl font-semibold tabular-nums text-nq-text">{amount}</p>
        <p className="text-sm text-nq-muted">{review.cardBrand && /^\d{4}$/.test(review.cardLast4)
          ? `${review.reviewKind === "group" ? vi ? "Thẻ người tổ chức" : "Organizer card" : vi ? "Thẻ đã lưu" : "Saved card"}: ${review.cardBrand} •••• ${review.cardLast4}`
          : vi ? "Chưa có thông tin thẻ hợp lệ để thu." : "No valid card information for collection."}</p>
        <p className="text-sm text-nq-muted" role="status">{status}</p>
        {eligible || canWaive ? <div className="flex flex-col gap-3 sm:flex-row">
        {eligible ? <Button variant="danger" size="lg" fullWidth disabled={pendingId !== null} onClick={() => setConfirmation({ review, amount, action: "collect" })}>
          {review.state === "pending_review" ? vi ? `Duyệt và thu ${amount}` : `Approve and collect ${amount}` : vi ? `Thu ${amount}` : `Collect ${amount}`}
        </Button> : null}
        {canWaive ? <Button variant="secondary" size="lg" fullWidth disabled={pendingId !== null} onClick={() => setConfirmation({ review, amount, action: "waive" })}>
          {vi ? "Miễn phí hủy" : "Waive cancellation fee"}
        </Button> : null}
        </div> : null}
      </Card>;
    })}
    {message ? <p role="status" className="text-sm text-nq-text">{message}</p> : null}
    <div className="flex flex-col gap-3">
      <Button variant="secondary" size="lg" disabled={pendingId !== null} onClick={() => router.refresh()}>{vi ? "Cập nhật trạng thái" : "Refresh status"}</Button>
      <Link prefetch={false} href={`/dashboard/${encodeURIComponent(slug)}/no-show-protection`} className="inline-flex min-h-11 items-center justify-center text-sm text-nq-muted underline underline-offset-4">{vi ? "Xem tất cả phiếu phí và miễn phí" : "View all fee reviews and waiver options"}</Link>
    </div>
    <FeeCollectionConfirmation
      isOpen={confirmation?.action === "collect"}
      amount={confirmation?.amount ?? ""}
      cardBrand={confirmation?.review.cardBrand ?? ""}
      cardLast4={confirmation?.review.cardLast4 ?? ""}
      kind={confirmation?.review.reviewKind ?? "late"}
      approveBeforeCollect={confirmation?.review.state === "pending_review"}
      vi={vi}
      busy={pendingId !== null}
      onCancel={() => setConfirmation(null)}
      onConfirm={() => void confirm()}
    />
    <Modal isOpen={confirmation?.action === "waive"} size="sm"
      title={vi ? "Xác nhận miễn phí hủy" : "Confirm cancellation fee waiver"}
      onClose={() => { if (pendingId === null) setConfirmation(null); }}
      showCloseButton={pendingId === null} closeOnBackdrop={pendingId === null}
      footer={<div className="flex flex-wrap justify-end gap-3">
        <Button variant="ghost" size="lg" disabled={pendingId !== null} onClick={() => setConfirmation(null)}>{vi ? "Quay lại" : "Go back"}</Button>
        <Button variant="primary" size="lg" loading={pendingId !== null} onClick={() => void confirmWaiver()}>{vi ? "Xác nhận miễn phí hủy" : "Confirm waiver"}</Button>
      </div>}
    >
      <div className="space-y-3 text-sm text-nq-text">
        <p className="font-semibold">{data.clientName} · {confirmation?.amount}</p>
        <p>{vi ? "Miễn khoản phí hủy này và đóng phiếu. Thẻ sẽ không bị trừ tiền từ phiếu này; lịch hẹn vẫn đã hủy." : "Waive this cancellation fee and close the review. This review will not charge the card; the appointment remains cancelled."}</p>
        <p className="text-nq-muted">{vi ? "Hệ thống lưu người xác nhận và thời điểm miễn. Quyết định miễn không thể đổi thành thu trên cùng phiếu." : "Your identity and the waiver time are recorded. This waived review cannot later be changed to a charge."}</p>
      </div>
    </Modal>
  </section>;
}
