"use client";
import { Suspense, useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import { NoShowCardCapture } from "@/components/booking/NoShowCardCapture";
import { bookingEn } from "@/shared/i18n/booking/en";
import { bookingVi } from "@/shared/i18n/booking/vi";
import { buildBookingThemeVars } from "@/shared/booking/bookingThemeVars";
import { formatCurrency, type Currency } from "@/shared/lib/currencyFormat";
const subscribe = () => () => {};
const serverLanguage = () => "en";
function language() { return /(?:^|; )nq-booking-lang=vi(?:;|$)/.test(document.cookie) ? "vi" : "en"; }

function SaveCardManager() {
  const token = useSearchParams()?.get("token") ?? "";
  const lang = useSyncExternalStore(subscribe, language, serverLanguage);
  const t = lang === "vi" ? bookingVi : bookingEn;
  const [loadedBooking, setBooking] = useState<{ token: string; bookingId: string; salonName: string; currencyCode: string; service: string; bookingTime: string; brandColor: string; themeMode: "light" | "dark"; timezone: string } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void fetch(`/api/booking/save-card-context?token=${encodeURIComponent(token)}`, { cache: "no-store", signal: abort.signal })
      .then(async (response) => { const value = await response.json(); if (response.ok && value.ok === true) setBooking({ ...value, token }); })
      .catch(() => {});
    return () => abort.abort();
  }, [token]);
  const booking = loadedBooking?.token === token ? loadedBooking : null;
  const brand = /^#[0-9a-f]{6}$/i.test(booking?.brandColor ?? "") ? booking!.brandColor : "#D4AF37";
  const theme = { ...buildBookingThemeVars(brand, booking?.themeMode ?? "light"), "--salon-primary":"var(--cta-bg)" } as CSSProperties;
  let appointmentTime = "";
  try { if (booking) appointmentTime = new Intl.DateTimeFormat(lang === "vi" ? "vi-VN" : "en-CA", {
    timeZone:booking.timezone,dateStyle:"medium",timeStyle:"short" }).format(new Date(booking.bookingTime)); } catch { /* Safe optional label. */ }
  return (
    <main style={theme} className="min-h-screen bg-[var(--booking-bg)] text-[var(--booking-text)]">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-5 py-10">
        <header>
          <h1 className="text-2xl font-semibold">{t.cardProtection.title}</h1>
          {booking ? <p className="mt-2 text-sm text-[var(--booking-text-muted)]">{booking.salonName} · {booking.service}<br />{appointmentTime}</p> : null}
        </header>
        <NoShowCardCapture bookingId={booking?.bookingId ?? ""} managementToken={token} t={t}
          currencyFormat={(cents) => formatCurrency(cents, (booking?.currencyCode ?? "CAD") as Currency) ?? ""} />
      </div>
    </main>
  );
}
export default function SaveCardPage() { return <Suspense fallback={<main className="min-h-screen" />}><SaveCardManager /></Suspense>; }
