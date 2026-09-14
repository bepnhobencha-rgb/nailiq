"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { PendingBookingCreateResolution } from "@/components/booking/PendingBookingCreateResolution";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import { useBookingRecoveryTheme } from "@/shared/booking/bookingRecoveryAppearance";
import { clearPendingBookingCreate, parsePendingBookingCreate } from "@/shared/booking/pendingBookingCreate";
import { parseCommittedCardRecovery } from "@/shared/booking/committedCardRecovery";
function subscribe(listener: () => void) { window.addEventListener("hashchange", listener); return () => window.removeEventListener("hashchange", listener); }
const fragment = () => window.location.hash;
const serverFragment = (): string | null => null;
const language = () => /(?:^|; )nq-booking-lang=vi(?:;|$)/.test(document.cookie);
const serverLanguage = () => false;
type Status = "checking" | "pending" | "expired" | "unavailable" | "resolved";
export default function RecoverBookingPage() {
  const router = useRouter();
  const hashSnapshot = useSyncExternalStore(subscribe, fragment, serverFragment);
  const hash = hashSnapshot ?? "";
  const vi = useSyncExternalStore(subscribe, language, serverLanguage);
  const binding = parsePendingBookingCreate(hash);
  const flight = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{hash: string; status: Status} | null>(null);
  const status = result?.hash === hash ? result.status : null;
  useEffect(() => () => { flight.current?.abort(); flight.current = null; }, [hash]);
  async function check() {
    if (!binding || flight.current || (status === "expired" || status === "resolved")) return;
    const controller = new AbortController(); flight.current = controller;
    setResult({ hash, status: "checking" });
    const timer = setTimeout(() => { if (controller.signal.aborted) return; controller.abort(); setResult({ hash, status: "unavailable" }); if (flight.current === controller) flight.current = null; }, 5000);
    try {
      const response = await fetch("/api/booking/create-recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(binding), cache: "no-store", signal: controller.signal });
      const value = await response.json();
      if (controller.signal.aborted) return;
      const href = typeof value.recoveryHref === "string" ? value.recoveryHref : "";
      const recovered = href.startsWith("/booking/recover-card#") ? parseCommittedCardRecovery(href.slice("/booking/recover-card".length)) : null;
      if (response.ok && value.ok === true && value.status === "found" && recovered && recovered.salonId === binding.salonId && recovered.idempotencyKey === binding.idempotencyKey && recovered.pricingFingerprint === binding.pricingFingerprint) {
        try { clearPendingBookingCreate(window.sessionStorage, binding); } catch { /* The fragment still carries authority. */ }
        router.replace(href); return;
      }
      setResult({ hash, status: response.ok && value.ok === true && ["pending", "expired"].includes(value.status) ? value.status : "unavailable" });
    } catch { if (!controller.signal.aborted) setResult({ hash, status: "unavailable" }); }
    finally { clearTimeout(timer); if (flight.current === controller) flight.current = null; }
  }
  const theme = useBookingRecoveryTheme(binding?.salonId);
  return <main style={theme} className="min-h-screen bg-[var(--booking-bg)] text-[var(--booking-text)]">
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-5 py-10">
      <h1 className="text-2xl font-semibold">{vi ? "Kiểm tra lịch đã gửi" : "Check submitted booking"}</h1>
      {status !== "resolved" ? <p className="text-sm leading-relaxed text-[var(--booking-text-muted)]">{vi ? "Kết nối bị gián đoạn nên chúng tôi chưa nhận được kết quả đặt lịch. Lịch hẹn có thể đã được giữ. Vui lòng kiểm tra trước khi đặt thêm." : "The connection was interrupted before we received your booking result. Your appointment may already be reserved. Please check before making another booking."}</p> : null}
      <p role="status" aria-live="polite" className="text-sm leading-relaxed text-[var(--booking-text-muted)]">{
        hashSnapshot === null ? "Loading recovery link… / Đang đọc liên kết…" :
        !binding || status === "expired" ? (vi ? "Liên kết không còn khả dụng. Vui lòng liên hệ tiệm để kiểm tra lịch đã gửi." : "This link is unavailable. Please contact the salon to check your booking.") :
        status === "checking" ? (vi ? "Đang kiểm tra lịch đã gửi…" : "Checking your booking…") :
        status === "pending" ? (vi ? "Chưa tìm thấy kết quả xác nhận. Điều này chưa có nghĩa là đặt lịch thất bại. Hãy kiểm tra lại sau ít phút hoặc liên hệ tiệm." : "No confirmed result was found yet. This does not mean your booking failed. Check again shortly or contact the salon.") :
        status === "unavailable" ? (vi ? "Chưa thể kiểm tra lúc này. Vui lòng thử kiểm tra lại." : "We could not check right now. Please try checking again.") :
        (vi ? "Kiểm tra lịch đã gửi sẽ không tạo thêm lịch mới." : "Checking your booking will not create another reservation.")}</p>
      {binding && (status === "pending" || status === "expired" || status === "resolved") ? <PendingBookingCreateResolution key={hash} binding={{ ...binding, kind: binding.kind }} vi={vi} onResolved={() => { clearPendingBookingCreate(window.sessionStorage, binding); setResult({ hash, status: "resolved" }); }} /> : null}
      {binding && status !== "expired" && status !== "resolved" ? <LuxuryBookingCta disabled={status === "checking"} onClick={check}>{vi ? "Kiểm tra lịch đã gửi" : "Check submitted booking"}</LuxuryBookingCta> : null}
    </div>
  </main>;
}
