import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type React from "react";

import { BookingTypeSwitcher } from "@/components/booking/BookingTypeSwitcher";
import { BookingFlowErrorBoundary } from "@/components/booking/BookingFlowErrorBoundary";
import { loadServiceCategories } from "@/shared/booking/loadServiceCategories";
import { resolvePublicBookingPage } from "@/shared/booking/resolvePublicBookingPage";
import { buildBookingThemeVars } from "@/shared/booking/bookingThemeVars";
import {
  getBookingMessages,
  resolveBookingLanguage,
} from "@/shared/i18n/booking";
import { EmbedFrameBridge } from "./EmbedFrameBridge";
import { SalonClosureBanner } from "@/components/booking/SalonClosureBanner";
import { hasUpcomingClosure } from "@/shared/booking/upcomingClosureNotice";

/**
 * Embeddable booking flow — the SAME flow as `/[slug]` but stripped to just the
 * booking card (no hero, nav, sections, JSON-LD). Designed to be framed into a
 * salon's own website by the `/embed.js` widget. This route is the ONLY framable
 * surface (see next.config `frame-ancestors *`); everything else stays DENY.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

type EmbedBookingPageProps = {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ lang?: string }>;
};

export default async function EmbedBookingPage({
  params,
  searchParams,
}: EmbedBookingPageProps) {
  const { slug } = await params;
  // The host site dictates the language via `?lang=en|vi` (so an English
  // marketing page never shows a Vietnamese booking flow); fall back to the
  // cookie / Accept-Language resolution when it's absent.
  const sp = (await searchParams) ?? {};

  const resolved = await resolvePublicBookingPage(slug);
  if (resolved.status === "redirect") {
    redirect(`/embed/${resolved.to.replace(/^\/+/, "")}`);
  }
  if (resolved.status === "reserved" || resolved.status === "not_found") {
    notFound();
  }
  if (resolved.status === "error") {
    // Same rule as /[slug]: a failed lookup is a 5xx, never a 404. The embed is
    // iframed into a salon's own website, so answering 404 during a database
    // blip would tell their visitors the salon does not exist.
    throw new Error(
      `Embed booking lookup failed for "${resolved.normalizedSlug}": ${resolved.reason}`,
    );
  }

  const { load, normalizedSlug } = resolved;

  // Resolved after the salon loads: the last-resort fallback is the salon's own
  // default_language, not a hardcoded "vi".
  const lang =
    sp.lang === "en" || sp.lang === "vi"
      ? sp.lang
      : await resolveBookingLanguage(load.salon.defaultLanguage);
  const t = getBookingMessages(lang);

  const themeVars = buildBookingThemeVars(
    load.salon.brandColor,
    load.salon.themeMode === "light" ? "light" : "dark",
  );
  const brandStyle = {
    "--salon-primary": load.salon.brandColor,
    "--brand": load.salon.brandColor,
    ...themeVars,
    "--shadow-nq-tile-selected": `0 0 0 1px ${load.salon.brandColor}, 0 18px 50px -20px rgba(0, 0, 0, 0.55), 0 0 40px -8px color-mix(in srgb, ${load.salon.brandColor} 35%, transparent)`,
  } as React.CSSProperties;

  return (
    <div
      className="nq-booking-embed bg-[var(--booking-bg)] text-[var(--booking-text)]"
      style={brandStyle}
    >
      <EmbedFrameBridge />
      <div className="mx-auto w-full max-w-[680px] px-4 py-6 sm:px-6 sm:py-7">
        {load.salon.closureNotice &&
        hasUpcomingClosure(load.salon.booking_closed_dates, load.salon.timezone) ? (
          <SalonClosureBanner notice={load.salon.closureNotice} />
        ) : null}
        <BookingFlowErrorBoundary shopSlug={normalizedSlug} salon={load.salon}>
          <BookingTypeSwitcher
            t={t}
            shopSlug={normalizedSlug}
            services={load.services}
            addOns={load.addOns}
            combos={load.combos}
            staff={load.staff}
            salon={load.salon}
            capabilityRows={load.capabilityRows}
            categories={await loadServiceCategories()}
            language={lang}
            voiceAiEnabled={load.salon.voiceAiEnabled}
            groupBookingEnabled={load.salon.groupBookingEnabled}
          />
        </BookingFlowErrorBoundary>
      </div>
    </div>
  );
}
