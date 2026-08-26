"use client";

import Link from "next/link";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ANALYTICS_CONSENT_CHANGED_EVENT,
  ANALYTICS_CONSENT_STORAGE_KEY,
  analyticsPageCategory,
  readAnalyticsConsent,
  resolveGoogleAnalyticsId,
  setGoogleAnalyticsDisabled,
  trackAnalyticsPageView,
  writeAnalyticsConsent,
  type AnalyticsConsent,
} from "@/shared/analytics/bookingFunnel";
import { useUserLanguageContext } from "@/shared/lib/UserLanguageContext";

type ConsentState = AnalyticsConsent | "loading" | null;

export function AnalyticsConsentManager({
  measurementId: rawMeasurementId,
}: {
  measurementId?: string;
}) {
  const measurementId = resolveGoogleAnalyticsId(rawMeasurementId);
  const { language } = useUserLanguageContext();
  const pathname = usePathname();
  const [consent, setConsent] = useState<ConsentState>("loading");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!measurementId) return;
    const stored = readAnalyticsConsent();
    setGoogleAnalyticsDisabled(measurementId, stored !== "granted");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot hydration from versioned local preference
    setConsent(stored);
  }, [measurementId]);

  useEffect(() => {
    if (consent !== "granted") return;
    trackAnalyticsPageView(analyticsPageCategory(pathname));
  }, [consent, pathname]);

  useEffect(() => {
    if (!measurementId) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== ANALYTICS_CONSENT_STORAGE_KEY) return;
      const next = readAnalyticsConsent();
      setGoogleAnalyticsDisabled(measurementId, next !== "granted");
      setConsent(next);
    };
    const onLocalChange = (event: Event) => {
      const next = (event as CustomEvent<AnalyticsConsent>).detail;
      setGoogleAnalyticsDisabled(measurementId, next !== "granted");
      setConsent(next);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, onLocalChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, onLocalChange);
    };
  }, [measurementId]);

  if (!measurementId || consent === "loading") return null;

  const vi = language === "vi";
  const showDialog = consent === null || editing;

  const choose = (next: AnalyticsConsent) => {
    setGoogleAnalyticsDisabled(measurementId, next !== "granted");
    if (!writeAnalyticsConsent(next)) return;
    setEditing(false);
  };

  return (
    <>
      {consent === "granted" ? (
        <>
          <Script id="nailiq-ga-init" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){window.dataLayer.push(arguments);}
              window.gtag = window.gtag || gtag;
              gtag('js', new Date());
              gtag('config', '${measurementId}', {
                send_page_view: false,
                page_location: window.location.origin,
                page_referrer: '',
                allow_google_signals: false,
                allow_ad_personalization_signals: false
              });
            `}
          </Script>
          <Script
            id="nailiq-ga"
            src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
            strategy="afterInteractive"
          />
        </>
      ) : null}
      {showDialog ? (
        <aside
          role="region"
          aria-label={vi ? "Lựa chọn quyền riêng tư" : "Privacy choices"}
          data-testid="analytics-consent-banner"
          className="fixed inset-x-3 bottom-3 z-[100] mx-auto max-w-3xl rounded-2xl border border-black/10 bg-white/95 p-4 text-slate-900 shadow-2xl backdrop-blur sm:p-5"
        >
          <p className="text-sm font-semibold sm:text-base">
            {vi ? "Cho phép đo lường giới hạn?" : "Allow limited analytics?"}
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-600 sm:text-sm">
            {vi
              ? "NailIQ chỉ gửi các mốc của luồng đặt lịch để tìm chỗ khách gặp khó khăn. Không gửi tên, số điện thoại, email, ghi chú, nội dung biểu mẫu hay mã salon."
              : "NailIQ sends only booking-flow milestones to find where guests get stuck. We do not send names, phone numbers, email, notes, form contents, or salon identifiers."} {" "}
            <Link href="/privacy" className="font-medium underline underline-offset-2">
              {vi ? "Chi tiết quyền riêng tư" : "Privacy details"}
            </Link>
          </p>
          <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              data-testid="analytics-consent-deny"
              onClick={() => choose("denied")}
              className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
            >
              {vi ? "Không cho phép" : "Decline"}
            </button>
            <button
              type="button"
              data-testid="analytics-consent-grant"
              onClick={() => choose("granted")}
              className="min-h-11 rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
            >
              {vi ? "Cho phép" : "Allow"}
            </button>
          </div>
        </aside>
      ) : (
        <button
          type="button"
          data-testid="analytics-consent-manage"
          onClick={() => setEditing(true)}
          className="fixed bottom-3 left-3 z-[90] min-h-9 rounded-full border border-black/10 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-md backdrop-blur hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        >
          {vi ? "Quyền riêng tư" : "Privacy choices"}
        </button>
      )}
    </>
  );
}
