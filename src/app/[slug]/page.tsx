import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { BookingTypeSwitcher } from "@/components/booking/BookingTypeSwitcher";
import { SalonBookingPaused } from "@/components/booking/SalonBookingPaused";
import { BookingMobileHero } from "@/components/booking/BookingMobileHero";
import { BookingSalonHero } from "@/components/booking/BookingSalonHero";
import { SalonBookingSkeleton } from "@/components/booking/SalonBookingSkeleton";
import { BookingFlowErrorBoundary } from "@/components/booking/BookingFlowErrorBoundary";
import { loadServiceCategories } from "@/shared/booking/loadServiceCategories";
import {
  resolvePublicBookingPage,
  type ResolvedPublicBookingPage,
} from "@/shared/booking/resolvePublicBookingPage";
import { loadSalonPageSections } from "@/shared/booking/loadSalonPageSections";
import { SalonPageSections } from "@/components/booking/SalonPageSections";
import { buildBookingThemeVars } from "@/shared/booking/bookingThemeVars";
import {
  getBookingMessages,
  resolveBookingLanguage,
} from "@/shared/i18n/booking";
import { formatSalonDisplayName } from "@/shared/lib/salonDisplay";
import { BookingDocumentEn } from "./BookingDocumentEn";
import { BookingLanguageToggle } from "@/components/booking/BookingLanguageToggle";
import { BookingChatWidget } from "@/components/booking/BookingChatWidget";
import { getSalonLocalBusinessJsonLd } from "@/shared/seo/jsonLd";
import { resolveVertical } from "@/shared/verticals/registry";
import { loadPublicNailTryOnSalon } from "@/shared/nailTryOn/publicSalon";
import { SalonClosureBanner } from "@/components/booking/SalonClosureBanner";
import { hasUpcomingClosure } from "@/shared/booking/upcomingClosureNotice";

/** Avoid stale static segments for salons created after deploy. */
export const dynamic = "force-dynamic";


type PublicBookingPageProps = {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ preview?: string; lang?: string }>;
};

export async function generateMetadata({
  params,
}: PublicBookingPageProps): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await resolvePublicBookingPage(slug);
  if (resolved.status === "reserved") {
    return { title: { absolute: "Not found | NailIQ" } };
  }
  if (resolved.status === "redirect") {
    redirect(resolved.to);
  }
  if (resolved.status === "not_found") {
    return {
      title: { absolute: "Page not found | NailIQ" },
      description: "This page does not exist.",
      robots: { index: false, follow: false },
    };
  }
  if (resolved.status === "error") {
    // A failed lookup is not a missing page. Emit neutral metadata and, above
    // all, do NOT set `robots: noindex` — the page component throws for this
    // status, so the request ends as a 5xx. Telling a crawler "do not index"
    // during a database blip is how a live salon quietly leaves the index.
    return { title: { absolute: "NailIQ" } };
  }
  const name = resolved.load.salon.name || resolved.normalizedSlug;
  const canonicalUrl = `https://nailiq.ca/${slug}`;
  return {
    title: `Book ${name}`,
    description: `Book nail and beauty appointments at ${name}. English-only guest experience on NailIQ.`,
    alternates: {
      canonical: canonicalUrl,
      languages: {
        en: canonicalUrl,
        vi: canonicalUrl,
      },
    },
  };
}

async function PublicBookingRouteBody({
  resolved,
  langOverride,
}: {
  resolved: Extract<ResolvedPublicBookingPage, { status: "ok" }>;
  langOverride?: "en" | "vi";
}) {
  const { load, normalizedSlug } = resolved;

  // P0.1 — resolve booking locale. An explicit `?lang=en|vi` wins (so links from
  // Google / a salon's own site can pin the language); then the cookie, then
  // Accept-Language. Only when the visitor gives no signal at all does the
  // salon's own default apply — so a US salon isn't read in Vietnamese by a
  // reviewer or crawler, while a Vietnamese-speaking guest still gets Vietnamese.
  // Resolved after the salon loads because it now depends on the salon.
  const lang = langOverride ?? (await resolveBookingLanguage(load.salon.defaultLanguage));
  const t = getBookingMessages(lang);

  const shopLabel = formatSalonDisplayName({
    name: load.salon.name,
    slug: normalizedSlug,
  });

  // Per-salon brand color (PR #109 + #110 fix): Tailwind v4's
  // `@theme inline` block compiles `bg-nq-primary` to a literal hex
  // at build time, so overriding `--color-nq-primary` on a wrapper
  // does NOT cascade into utility classes (BUG that prompted this
  // fix). Instead we expose `--salon-primary` and override the
  // hand-rolled `:root` vars (.nq-booking-luxury-cta gradient,
  // tile-selected shadow). Components that need the brand reference
  // `var(--salon-primary)` directly via Tailwind arbitrary syntax
  // (`bg-[var(--salon-primary)]`, `text-[var(--salon-primary)]`).
  //
  // Theme mode (PR: this commit): per-salon light/dark for the
  // booking page only. Exposes a `--booking-*` palette that
  // downstream components consume via `var(...)` so a salon can
  // flip to a light scheme without touching the dashboard. Same
  // wrapper-override pattern as `--salon-primary` above.
  // CTA pill uses high-contrast black/white per the simpler Square-
  // style philosophy: brand color is reserved for accent details
  // (step dots, prices, selected-state highlights, focus rings) and
  // the big Continue / Confirm pill flips to plain monochrome.
  // Dark mode → white button on dark page; light mode → dark
  // button on light page. The previous brand-derived gold gradient
  // (`--nq-luxury-cta-from/mid/to`) is no longer threaded through —
  // `.nq-booking-luxury-cta` now reads `--cta-bg` / `--cta-text`
  // directly.
  // Branded canvas: surfaces are derived from the salon's brand colour with a
  // luminance-adaptive tint so the booking page echoes their brand tone (text
  // + CTA stay fixed for contrast). See buildBookingThemeVars.
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

  const localBusinessSchema = getSalonLocalBusinessJsonLd({
    slug: normalizedSlug,
    name: load.salon.name,
    description: load.salon.description,
    address: load.salon.address,
    phone: load.salon.salonPhone,
    timezone: load.salon.timezone,
    vertical: load.salon.vertical,
  });

  // Vertical-specific fallback tagline for the booking hero. Only used when the
  // salon has no custom `description`; `nail_salon` omits it so the existing
  // i18n copy still wins (preserved in both languages).
  const heroFallbackTagline = resolveVertical(load.salon.vertical).heroTagline?.[
    lang === "vi" ? "vi" : "en"
  ];

  // Booking imagery: per-salon override (salon's own photos) → else the
  // vertical default (head spa → spa photos, not nail). Ambient backdrop +
  // hero panel both derive from this.
  const bookingImagery =
    load.salon.bookingImages ?? resolveVertical(load.salon.vertical).bookingImagery;
  const ambientSrc = `${bookingImagery.hero}?auto=format&fit=crop&q=55&w=2400`;

  // Website-builder sections (opt-in per salon). Rendered above the booking
  // flow when `public_sections_enabled` is on; otherwise the page is unchanged.
  const pageSections = load.salon.publicSectionsEnabled
    ? await loadSalonPageSections(load.salon.id)
    : [];
  const nailTryOnSalon = await loadPublicNailTryOnSalon(normalizedSlug);

  if (!load.salon.acceptingBookings) {
    return (
      <>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(localBusinessSchema) }}
        />
        <BookingDocumentEn lang={lang} />
        <div
          className="relative min-h-dvh px-4 py-10 pb-safe sm:px-6 lg:px-8"
          style={{
            ...brandStyle,
            background: "var(--booking-bg)",
            color: "var(--booking-text)",
          }}
        >
          <SalonBookingPaused shopLabel={shopLabel} t={t} />
        </div>
      </>
    );
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(localBusinessSchema) }}
      />
      {/* QA re-test follow-up — the prop was missing on this branch
          so `<html lang>` defaulted to "vi" forever even after the
          user flipped to EN, which throws screen readers into
          Vietnamese phonetics for English copy. */}
      <BookingDocumentEn lang={lang} />
      <div
        className="relative min-h-dvh"
        style={{
          ...brandStyle,
          background: "var(--booking-bg)",
          color: "var(--booking-text)",
        }}
      >
        <div
          className="pointer-events-none fixed inset-0 -z-10 hidden lg:block"
          aria-hidden
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={ambientSrc}
            alt=""
            aria-hidden="true"
            loading="lazy"
            className="h-full w-full object-cover opacity-[0.18]"
          />
          <div className="absolute inset-0 backdrop-blur-[3px] bg-[color-mix(in_srgb,var(--booking-bg)_86%,transparent)]" />
        </div>

        {/* P0.1 — language toggle anchored top-right; floats above
            the main column so it doesn't push the layout. */}
        <div className="pointer-events-none absolute top-4 right-4 z-20 sm:top-6 sm:right-6 lg:top-8 lg:right-8">
          <div className="pointer-events-auto">
            <BookingLanguageToggle currentLang={lang} />
          </div>
        </div>

        {load.salon.closureNotice &&
        hasUpcomingClosure(load.salon.booking_closed_dates, load.salon.timezone) ? (
          <div className="relative z-10 mx-auto w-full max-w-[1200px] px-4 pt-6 sm:px-6 lg:px-8">
            <SalonClosureBanner notice={load.salon.closureNotice} />
          </div>
        ) : null}

        {pageSections.length > 0 ? (
          <SalonPageSections
            sections={pageSections}
            services={load.services}
            currency={load.salon.currencyCode}
            lang={lang}
            salonName={load.salon.name}
            salonAddress={load.salon.address}
            salonPhone={load.salon.salonPhone}
          />
        ) : null}

        <main id="book" className="relative z-10 mx-auto w-full max-w-[1200px] px-4 py-10 pb-safe sm:px-6 lg:flex lg:items-start lg:gap-10 lg:px-8 lg:py-14">
          <BookingSalonHero
            shopLabel={shopLabel}
            logoUrl={load.salon.logoUrl}
            t={t}
            themeMode={load.salon.themeMode}
            address={load.salon.address}
            openingHoursRaw={load.salon.opening_hours}
            timezone={load.salon.timezone}
            description={load.salon.description}
            fallbackTagline={heroFallbackTagline}
            imagery={bookingImagery}
            lang={lang}
            className="lg:sticky lg:top-10 lg:flex-shrink-0"
          />

          <div className="min-w-0 flex-1 lg:max-w-[min(100%,740px)] lg:pt-1">
            <BookingMobileHero
              shopLabel={shopLabel}
              logoUrl={load.salon.logoUrl}
              t={t}
              themeMode={load.salon.themeMode}
              address={load.salon.address}
              openingHoursRaw={load.salon.opening_hours}
              timezone={load.salon.timezone}
              description={load.salon.description}
              fallbackTagline={heroFallbackTagline}
              lang={lang}
            />
            {nailTryOnSalon ? (
              <a
                href={`/${normalizedSlug}/try-on?lang=${lang}`}
                className="mb-5 flex min-h-14 items-center justify-between gap-4 rounded-2xl border border-[color-mix(in_srgb,var(--salon-primary)_35%,transparent)] bg-[color-mix(in_srgb,var(--salon-primary)_10%,var(--booking-surface))] px-4 py-3 transition hover:-translate-y-0.5"
              >
                <span>
                  <span className="block text-sm font-semibold text-[var(--booking-text)]">
                    {lang === "vi" ? "Thử mẫu nail trên tay bạn" : "Try a nail look on your hand"}
                  </span>
                  <span className="mt-0.5 block text-xs text-[var(--booking-text-muted)]">
                    {lang === "vi" ? "Chụp một ảnh · Xem trước bằng AI" : "One photo · Private AI preview"}
                  </span>
                </span>
                <span aria-hidden className="text-xl">→</span>
              </a>
            ) : null}
            <h1 className="hidden lg:block text-2xl font-semibold tracking-tight text-[var(--booking-text)] sm:text-3xl lg:text-[2.125rem] lg:leading-[1.15] lg:tracking-[-0.035em]">
              {t.pageTitle}
            </h1>
            <p className="mt-4 text-sm text-[var(--booking-text-muted)] sm:text-base lg:mt-3 lg:text-[17px] lg:leading-relaxed">
              {t.pageSubtitle}
            </p>
            <BookingFlowErrorBoundary
              shopSlug={normalizedSlug}
              salon={load.salon}
            >
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
        </main>

        {/* P1.4 — AI chat widget; only renders when ANTHROPIC_API_KEY is set */}
        {process.env.ANTHROPIC_API_KEY ? (
          <BookingChatWidget salonId={load.salon.id} t={t} />
        ) : null}

        {/* TEMPORARILY HIDDEN per request — gift-card purchase link on the
            booking page. To restore, delete this comment wrapper so the block
            renders again. (The /[slug]/gift page itself still exists.)
        <div className="mx-auto w-full max-w-[1200px] px-4 pb-8 text-center sm:px-6 lg:px-8">
          <a
            href={`/${normalizedSlug}/gift`}
            className="inline-flex items-center gap-1.5 text-sm text-[var(--booking-text-muted)] hover:text-[var(--salon-primary)] transition-colors"
          >
            🎁 {t.giftCardPageLink}
          </a>
        </div>
        */}
      </div>
    </>
  );
}

export default async function PublicBookingPage({ params, searchParams }: PublicBookingPageProps) {
  const sp = await searchParams;
  const isPreview = sp?.preview === "true";
  const langOverride =
    sp?.lang === "en" || sp?.lang === "vi" ? sp.lang : undefined;

  // Resolve the slug HERE, in the page shell — deliberately outside the
  // <Suspense> below.
  //
  // notFound() and redirect() work by throwing, and Next can only turn that
  // throw into a real HTTP status while the response headers are still
  // unsent. Inside a Suspense boundary the shell has already been streamed
  // with `200 OK` by the time the child resolves, so the throw arrives too
  // late: Next swaps in the not-found UI but the status stays 200. That is
  // exactly what happened here — the fix for BUG-07 (QA 2026-05-09) called
  // notFound() correctly, and the Suspense boundary silently defeated it, so
  // Google kept indexing 404 pages as live ones.
  //
  // Proof it is the boundary and not the resolver: /embed/[slug] runs the very
  // same resolvePublicBookingPage() and the very same notFound(), has no
  // Suspense, and returns a real 404.
  //
  // This costs no extra query: resolvePublicBookingPage is wrapped in React
  // cache(), and generateMetadata already awaits it for this request, so the
  // promise is shared. The Suspense boundary still earns its keep — the body
  // continues to await the language, page sections and service categories.
  const { slug } = await params;
  const resolved = await resolvePublicBookingPage(slug);

  if (resolved.status === "reserved") {
    notFound();
  }
  if (resolved.status === "redirect") {
    redirect(resolved.to);
  }
  if (resolved.status === "not_found") {
    notFound();
  }
  if (resolved.status === "error") {
    // The lookup failed — we do NOT know that this salon is gone. Throwing
    // gives a 5xx ("try again later"); answering 404 would tell Google a real,
    // paying salon no longer exists, and a 404 is how pages get de-indexed.
    // A database blip must never cost a salon its search ranking.
    throw new Error(
      `Public booking lookup failed for "${resolved.normalizedSlug}": ${resolved.reason}`,
    );
  }

  return (
    <>
      {isPreview && (
        <div className="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-3 bg-[#D4AF37] py-2 px-4 text-black text-sm font-medium shadow-md">
          <span>👁 Preview mode — trang này chưa công khai với khách</span>
          <a
            href={`/dashboard`}
            className="underline hover:no-underline text-xs"
          >
            Quay lại editor
          </a>
        </div>
      )}
      <div className={isPreview ? "pt-10" : ""}>
        <Suspense
          fallback={
            <>
              <BookingDocumentEn lang="vi" />
              <SalonBookingSkeleton />
            </>
          }
        >
          <PublicBookingRouteBody
            resolved={resolved}
            langOverride={langOverride}
          />
        </Suspense>
      </div>
    </>
  );
}
