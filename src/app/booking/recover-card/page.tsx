"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import { bookingEn } from "@/shared/i18n/booking/en";
import { bookingVi } from "@/shared/i18n/booking/vi";
import { useBookingRecoveryTheme } from "@/shared/booking/bookingRecoveryAppearance";
import { parseCommittedCardRecovery, recoverCommittedCardCapability, type CommittedCardRecoveryOutcome } from "@/shared/booking/committedCardRecovery";

function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}
const fragment = () => window.location.hash;
const serverFragment = (): string | null => null;
const language = () => /(?:^|; )nq-booking-lang=vi(?:;|$)/.test(document.cookie) ? "vi" : "en";
const serverLanguage = () => "en";
const COPY = {
  en: {
    title: "Check your appointment", intro: "Check the appointment details and whether a card is required. Please do not book again while checking.",
    check: "Check appointment", checking: "Checking appointment…", unavailable: "We could not check the appointment yet. Please try again or ask the salon for help.",
    expired: "This recovery link is invalid or has expired. Please ask the salon to check your appointment before booking again.",
    notApplicable: "Card management is unavailable for this link. Please ask the salon to check your appointment.",
    localTime: "Salon local time", services: "Services", noCardEntry: "You do not need to enter a card for this appointment.",
  },
  vi: {
    title: "Kiểm tra lịch hẹn", intro: "Kiểm tra thông tin lịch và việc có cần lưu thẻ hay không. Vui lòng đừng đặt lại trong lúc kiểm tra.",
    check: "Kiểm tra lịch hẹn", checking: "Đang kiểm tra lịch hẹn…", unavailable: "Chưa kiểm tra được lịch hẹn. Vui lòng thử lại hoặc nhờ salon hỗ trợ.",
    expired: "Liên kết khôi phục không hợp lệ hoặc đã hết hạn. Vui lòng nhờ salon kiểm tra lịch trước khi đặt lại.",
    notApplicable: "Liên kết này không hỗ trợ quản lý thẻ. Vui lòng nhờ salon kiểm tra lịch hẹn.",
    localTime: "Giờ tại salon", services: "Dịch vụ", noCardEntry: "Bạn không cần nhập thẻ cho lịch hẹn này.",
  },
} as const;

export default function RecoverCardPage() {
  const router = useRouter();
  const hashSnapshot = useSyncExternalStore(subscribe, fragment, serverFragment);
  const hash = hashSnapshot ?? "";
  const lang = useSyncExternalStore(subscribe, language, serverLanguage);
  const t = lang === "vi" ? bookingVi : bookingEn;
  const copy = COPY[lang === "vi" ? "vi" : "en"];
  const binding = parseCommittedCardRecovery(hash);
  const inFlight = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{ hash: string; outcome: CommittedCardRecoveryOutcome | { status: "checking" } } | null>(null);
  useEffect(() => () => { inFlight.current?.abort(); inFlight.current = null; }, [hash]);
  const outcome = result?.hash === hash ? result.outcome : null;
  const status = outcome?.status;
  const receipt = outcome?.status === "not_required" ? outcome.receipt : null;
  const terminal = status === "expired" || status === "not_required" || status === "not_applicable";
  const theme = useBookingRecoveryTheme(binding?.salonId);

  async function retry() {
    if (!binding || inFlight.current || terminal) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setResult({ hash, outcome: { status: "checking" } });
    const outcome = await recoverCommittedCardCapability(binding, fetch, controller.signal);
    if (!controller.signal.aborted) {
      setResult({ hash, outcome });
      if (outcome.status === "ready") router.replace(`/booking/save-card?token=${encodeURIComponent(outcome.token)}`);
    }
    if (inFlight.current === controller) inFlight.current = null;
  }

  return <main style={theme} className="min-h-screen bg-[var(--booking-bg)] text-[var(--booking-text)]">
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-5 py-10">
      <h1 className="text-2xl font-semibold">{receipt ? t.cardProtection.reserved : copy.title}</h1>
      {binding && !terminal ? <p className="text-sm leading-relaxed text-[var(--booking-text-muted)]">
        {copy.intro}
      </p> : null}
      <p role="status" aria-live="polite" className="text-sm leading-relaxed text-[var(--booking-text-muted)]">
        {hashSnapshot === null ? "Loading recovery link… / Đang đọc liên kết…"
          : !binding || status === "expired" ? copy.expired
          : status === "not_required" ? copy.noCardEntry
          : status === "not_applicable" ? copy.notApplicable
          : status === "checking" || status === "ready" ? copy.checking
          : status === "unavailable" ? copy.unavailable : null}
      </p>
      {receipt ? <section className="space-y-3 text-sm">
        <p className="font-semibold">{receipt.salonName}</p>
        <p>{new Intl.DateTimeFormat(lang === "vi" ? "vi-VN" : "en-CA", {
          timeZone: receipt.timezone, dateStyle: "full", timeStyle: "short",
        }).format(new Date(receipt.startTimeUtc))}<br />
          <span className="text-[var(--booking-text-muted)]">{copy.localTime} ({receipt.timezone})</span>
        </p>
        <p>{copy.services}: {receipt.services.join(" · ")}</p>
      </section> : null}
      {binding && !terminal ? <LuxuryBookingCta disabled={status === "checking" || status === "ready"} onClick={retry}>
        {copy.check}
      </LuxuryBookingCta> : null}
    </div>
  </main>;
}
