"use client";
import { useEffect, useRef, useState } from "react";
import { LuxuryBookingCta } from "./LuxuryBookingCta";
import { resolvePendingBookingCreateAction, type BookingCreateResolution } from "@/shared/booking/resolvePendingBookingCreateAction";
import { rememberRetiredBookingCreate } from "@/shared/booking/retiredBookingCreate";
import type { PendingGroupCreate } from "@/shared/booking/pendingGroupCreate";

export function PendingBookingCreateResolution({ binding, vi, onResolved }: {
  binding: PendingGroupCreate & { kind: "individual" | "sequence" | "group" };
  vi: boolean;
  onResolved: () => void;
}) {
  const [result, setResult] = useState<BookingCreateResolution | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => () => { generation.current += 1; }, []);
  async function resolve() {
    if (inFlight.current) return;
    inFlight.current = true;
    const version = ++generation.current;
    setBusy(true);
    const timer = setTimeout(() => {
      if (version !== generation.current) return;
      generation.current += 1; inFlight.current = false;
      setBusy(false); setResult({ status: "unavailable" });
    }, 6000);
    try {
      const value = await resolvePendingBookingCreateAction(binding);
      if (version !== generation.current) return;
      if (value.status === "retired" || value.status === "booking_exists") {
        if (value.status === "retired") rememberRetiredBookingCreate(binding.salonId, binding.idempotencyKey);
        onResolved();
      }
      setResult(value);
    } catch {
      if (version === generation.current) setResult({ status: "unavailable" });
    } finally {
      clearTimeout(timer);
      if (version === generation.current) { inFlight.current = false; setBusy(false); }
    }
  }
  const terminal = result?.status === "retired" || result?.status === "booking_exists" ? result : null;
  return <section className="flex flex-col gap-4">
    <p role="status" aria-live="polite" className="text-sm leading-relaxed text-[var(--booking-text-muted)]">{
      result?.status === "retired" ? (vi ? "Yêu cầu cũ đã được kết thúc an toàn và chưa tạo lịch hẹn. Bạn có thể bắt đầu đặt lại." : "The old request was safely closed without creating an appointment. You can start a new booking.") :
      result?.status === "booking_exists" ? (vi ? "Đã tìm thấy lịch từ yêu cầu này. Lịch không bị huỷ. Hãy liên hệ tiệm để kiểm tra hoặc thay đổi lịch; đừng đặt lại cùng lịch hẹn." : "A booking was found for this request. It has not been cancelled. Contact the salon to check or change it; do not book the same appointment again.") :
      result?.status === "pending" ? (vi ? "Yêu cầu vẫn đang được xử lý. Vui lòng kiểm tra lại sau ít phút." : "The request is still being processed. Please check again shortly.") :
      result?.status === "unavailable" ? (vi ? "Chưa thể xác nhận kết quả. Vui lòng thử lại; hệ thống chưa cho phép tạo lại lịch từ bước này." : "We could not confirm the result. Please try again; starting over has not been enabled.") :
      (vi ? "Chúng tôi sẽ kiểm tra lần cuối. Chỉ khi chưa có lịch và yêu cầu cũ đã được chặn an toàn, bạn mới có thể bắt đầu lại. Lịch đã tồn tại sẽ được giữ nguyên." : "We will check once more. Starting over is enabled only when no booking exists and the old request has been safely blocked. Any existing booking will be kept.")}</p>
    {terminal ? <LuxuryBookingCta onClick={() => { window.location.assign(terminal.salonPath); }}>{terminal.status === "retired" ? (vi ? "Bắt đầu đặt lại" : "Start a new booking") : (vi ? "Về trang tiệm" : "Return to salon")}</LuxuryBookingCta> :
      <LuxuryBookingCta disabled={busy} onClick={resolve}>{busy ? (vi ? "Đang kiểm tra…" : "Checking…") : (vi ? "Kiểm tra và kết thúc yêu cầu cũ" : "Check and close the old request")}</LuxuryBookingCta>}
  </section>;
}
