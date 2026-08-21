"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { NoShowCardCapture } from "@/components/booking/NoShowCardCapture";
import { formatCurrency, type Currency } from "@/shared/lib/currencyFormat";
// Import the message objects directly (NOT the i18n index, which pulls in the
// server-only resolveBookingLanguage → headers() and breaks the client build).
import { bookingEn, type BookingMessages } from "@/shared/i18n/booking/en";
import { bookingVi } from "@/shared/i18n/booking/vi";

const BOOKING_LANG_COOKIE = "nq-booking-lang";

type Ctx = {
  ok: boolean;
  bookingId: string;
  salonName: string;
  currencyCode: string;
  alreadySaved: boolean;
  cancelled: boolean;
  cardRequired: boolean;
  code?: string;
};

type Phase =
  | { phase: "loading" }
  | { phase: "ready"; ctx: Ctx }
  | { phase: "saved"; salonName: string }
  | { phase: "not_required" }
  | { phase: "error"; code: string };

function readBookingLang(): "en" | "vi" {
  if (typeof document === "undefined") return "vi";
  const m = document.cookie.match(
    new RegExp(`(?:^|; )${BOOKING_LANG_COOKIE}=([^;]+)`),
  );
  const raw = m ? decodeURIComponent(m[1]).toLowerCase() : "";
  return raw === "en" ? "en" : "vi";
}

function SaveCardManager() {
  const params = useSearchParams();
  const token = params?.get("token") ?? "";
  const [state, setState] = useState<Phase>({ phase: "loading" });
  const lang = useMemo(() => readBookingLang(), []);
  const t: BookingMessages = lang === "en" ? bookingEn : bookingVi;

  const load = useCallback(async () => {
    if (!token) {
      setState({ phase: "error", code: "missing_token" });
      return;
    }
    try {
      const res = await fetch(
        `/api/booking/save-card-context?token=${encodeURIComponent(token)}`,
      );
      const json = (await res.json()) as Ctx;
      if (!res.ok || !json.ok) {
        setState({ phase: "error", code: json.code ?? "load_failed" });
        return;
      }
      if (json.cancelled) {
        setState({ phase: "error", code: "cancelled" });
        return;
      }
      if (json.alreadySaved) {
        setState({ phase: "saved", salonName: json.salonName });
        return;
      }
      if (!json.cardRequired) {
        // Trusted/returning customer — no card needed (same gate as online).
        setState({ phase: "not_required" });
        return;
      }
      setState({ phase: "ready", ctx: json });
    } catch {
      setState({ phase: "error", code: "network_error" });
    }
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot token load; mirrors /booking/card
    void load();
  }, [load]);

  return (
    <main className="min-h-screen w-full bg-white">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-5 py-10">
        <header className="text-center">
          <h1 className="text-2xl font-semibold text-neutral-900">
            {lang === "en" ? "Hold your appointment" : "Giữ lịch hẹn của bạn"}
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {lang === "en"
              ? "Save a card to confirm — you're only charged if you don't show up."
              : "Lưu thẻ để xác nhận — bạn chỉ bị tính phí nếu không đến."}
          </p>
        </header>

        {state.phase === "loading" ? (
          <div className="animate-pulse rounded-2xl border border-neutral-200 bg-neutral-50 p-6">
            <div className="h-4 w-32 rounded bg-neutral-200" />
            <div className="mt-3 h-10 w-full rounded bg-neutral-200" />
          </div>
        ) : null}

        {state.phase === "ready" ? (
          <div className="rounded-2xl border border-neutral-200 bg-white p-5">
            {state.ctx.salonName ? (
              <p className="mb-3 text-center text-xs uppercase tracking-widest text-neutral-400">
                {state.ctx.salonName}
              </p>
            ) : null}
            {/* The proven capture component: fetches provider config + saves the
                card via the same APIs as the online booking flow. */}
            <NoShowCardCapture
              bookingId={state.ctx.bookingId}
              managementToken={token}
              currencyFormat={(cents) =>
                formatCurrency(cents, state.ctx.currencyCode as Currency) ?? ""
              }
              t={t}
            />
          </div>
        ) : null}

        {state.phase === "not_required" ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
            <p className="text-lg font-semibold text-emerald-800">
              {lang === "en" ? "You're all set ✓" : "Bạn đã xong ✓"}
            </p>
            <p className="mt-1 text-sm text-emerald-700">
              {lang === "en"
                ? "No card needed for this appointment — see you soon!"
                : "Lịch hẹn này không cần lưu thẻ — hẹn gặp bạn!"}
            </p>
          </div>
        ) : null}

        {state.phase === "saved" ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
            <p className="text-lg font-semibold text-emerald-800">
              {lang === "en" ? "Card on file ✓" : "Đã lưu thẻ ✓"}
            </p>
            <p className="mt-1 text-sm text-emerald-700">
              {lang === "en"
                ? "Your spot is held. You're only charged if you don't show up."
                : "Chỗ của bạn đã được giữ. Bạn chỉ bị tính phí nếu không đến."}
            </p>
          </div>
        ) : null}

        {state.phase === "error" ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center">
            <p className="text-sm font-medium text-amber-800">
              {state.code === "cancelled"
                ? "This appointment was cancelled. / Lịch hẹn này đã bị huỷ."
                : state.code === "expired_token" || state.code === "invalid_token"
                  ? "This link has expired. Please contact the salon. / Liên kết đã hết hạn, vui lòng liên hệ salon."
                  : "Something went wrong. Please try again. / Có lỗi xảy ra, vui lòng thử lại."}
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}

export default function SaveCardPage() {
  return (
    <Suspense fallback={<main className="min-h-screen" />}>
      <SaveCardManager />
    </Suspense>
  );
}
