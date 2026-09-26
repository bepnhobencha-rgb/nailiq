"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

type FeeKind = "no-show" | "late" | "group";

export function feePaymentStatusLabel(state: string, paymentStatus: string, vi: boolean): string {
  if (state === "waived") return vi ? "Đã miễn phí — không thu tiền" : "Waived — no charge";
  if (state === "invalidated" || state === "not_applicable") return vi ? "Không áp dụng thu phí" : "Fee not applicable";
  if (paymentStatus === "succeeded") return vi ? "Đã thu phí — có biên nhận" : "Collected — receipt recorded";
  if (paymentStatus === "failed") return vi ? "Thu phí không thành công" : "Collection failed";
  if (["dispatching", "pending_provider", "unknown"].includes(paymentStatus)) return vi ? "Đang đối soát — không thử lại" : "Reconciling — do not retry";
  if (paymentStatus === "dispatch_blocked") return vi ? "Đã duyệt — chưa thu tiền" : "Approved — not collected";
  return vi ? "Chưa thu tiền" : "Not collected";
}

export function feeActionError(error: string, vi: boolean): string {
  if (["unauthorized", "salon_mismatch"].includes(error)) return vi ? "Bạn không có quyền thực hiện thao tác này. Hãy tải lại trang để kiểm tra phiên đăng nhập." : "You cannot perform this action. Reload to check your session.";
  if (error === "dispatch_release_disabled") return vi ? "Chức năng thu phí chưa được bật. Chưa gửi lệnh thanh toán." : "Fee collection is not enabled. No payment was sent.";
  if (error === "provider_configuration_unavailable") return vi ? "Chưa kết nối được nhà cung cấp thanh toán. Chưa gửi lệnh thu phí." : "Payment provider configuration is unavailable. No payment was sent.";
  if (["card_declined", "expired_card", "insufficient_funds", "authentication_required"].includes(error)) return vi ? "Nhà cung cấp từ chối khoản thu. Chưa thu được phí; hãy kiểm tra thẻ và trạng thái trước khi xử lý tiếp." : "The provider declined the charge. The fee was not collected; check the card and status before proceeding.";
  return vi ? "Chưa xác nhận thu phí thành công. Hãy kiểm tra trạng thái cập nhật trước khi thao tác tiếp." : "Collection is not confirmed. Check the updated status before taking another action.";
}

/** One in-flight mutation per queue, including before React renders disabled controls. */
export function useFeeQueueMutation(vi: boolean, refresh: () => void) {
  const inFlight = useRef(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [unconfirmedIds, setUnconfirmedIds] = useState<Set<string>>(() => new Set());
  async function run(id: string, action: () => Promise<{ ok: boolean; error?: string }>, success: string, collection = false) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setPendingId(id);
    setMessage(null);
    if (collection) setUnconfirmedIds((current) => new Set(current).add(id));
    try {
      const result = await action();
      setMessage(result.ok ? success : feeActionError(result.error ?? "", vi));
      if (collection && !result.ok && ["dispatch_release_disabled", "provider_configuration_unavailable", "unauthorized", "salon_mismatch"].includes(result.error ?? "")) {
        setUnconfirmedIds((current) => { const next = new Set(current); next.delete(id); return next; });
      }
    } catch {
      if (collection) setUnconfirmedIds((current) => new Set(current).add(id));
      setMessage(collection
        ? vi ? "Mất kết nối khi thu phí. Kết quả chưa rõ; hãy tải lại để kiểm tra. Không thu lại khi chưa đối soát." : "Connection lost during collection. The result is unconfirmed; reload to check it. Do not collect again before reconciliation."
        : vi ? "Chưa nhận được kết quả. Hãy tải lại để kiểm tra trước khi thử lại." : "No result received. Reload to check before retrying.");
    } finally {
      inFlight.current = false;
      setPendingId(null);
      refresh();
    }
    return true;
  }
  return { pendingId, message, unconfirmedIds, run };
}

export function FeeCollectionConfirmation({
  isOpen, amount, cardBrand, cardLast4, kind, vi, busy, onCancel, onConfirm,
}: {
  isOpen: boolean; amount: string; cardBrand: string; cardLast4: string; kind: FeeKind;
  vi: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const fee = kind === "no-show" ? (vi ? "Phí no-show" : "No-show fee")
    : kind === "late" ? (vi ? "Phí hủy trễ" : "Late cancellation fee")
      : (vi ? "Phí hủy nhóm" : "Group cancellation fee");
  return <Modal
    isOpen={isOpen}
    onClose={() => { if (!busy) onCancel(); }}
    size="sm"
    title={vi ? "Xác nhận thu phí" : "Confirm fee collection"}
    showCloseButton={!busy}
    closeOnBackdrop={!busy}
    footer={<div className="flex flex-wrap justify-end gap-2">
      <Button variant="ghost" size="lg" disabled={busy} onClick={onCancel}>{vi ? "Hủy" : "Cancel"}</Button>
      <Button variant="danger" size="lg" loading={busy} onClick={onConfirm}>{vi ? `Xác nhận thu ${amount}` : `Confirm collection of ${amount}`}</Button>
    </div>}
  >
    <div className="space-y-3 text-sm text-nq-text">
      <p className="font-semibold">{fee} · {amount}</p>
      <p>{kind === "group" ? (vi ? "Thẻ người tổ chức" : "Organizer card") : (vi ? "Thẻ đã lưu" : "Saved card")}: {cardBrand} •••• {cardLast4}</p>
      <p className="text-nq-muted">{vi ? "Xác nhận sẽ gửi yêu cầu thu đúng số tiền này tới nhà cung cấp thanh toán. Đây là bước thu tiền, riêng với bước duyệt phí." : "Confirming sends this exact charge to the payment provider. This collects payment separately from fee approval."}</p>
      {busy ? <p role="status">{vi ? "Đang xử lý — vui lòng chờ kết quả." : "Processing — please wait for the result."}</p> : null}
    </div>
  </Modal>;
}
