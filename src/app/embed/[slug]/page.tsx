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
  const lang =
    sp.lang === "en" || sp.lang === "vi"
      ? sp.lang
      : await resolveBookingLanguage();
  const t = getBookingMessages(lang);

  const resolved = await resolvePublicBookingPage(slug);
  if (resolved.status === "redirect") {
    redirect(`/embed/${resolved.to.replace(/^\/+/, "")}`);
  }
  if (resolved.status === "reserved" || resolved.status === "not_found") {
    notFound();
  }

  const { load, normalizedSlug } = resolved;

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
