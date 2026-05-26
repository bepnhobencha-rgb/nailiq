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
import { resolvePublicBookingPage } from "@/shared/booking/resolvePublicBookingPage";
import {
  getBookingMessages,
  resolveBookingLanguage,
} from "@/shared/i18n/booking";
import { formatSalonDisplayName } from "@/shared/lib/salonDisplay";
import { BookingDocumentEn } from "./BookingDocumentEn";
import { BookingLanguageToggle } from "@/components/booking/BookingLanguageToggle";
import { BookingChatWidget } from "@/components/booking/BookingChatWidget";
import { getSalonLocalBusinessJsonLd } from "@/shared/seo/jsonLd";

/** Avoid stale static segments for salons created after deploy. */
export const dynamic = "force-dynamic";

/** Soft ambient layer behind split layout (`lg:`); matches hero imagery tone. */
const DESKTOP_BOOKING_AMBIENT_SRC =
  "https://images.unsplash.com/photo-1610992015732-2449b76344bc?auto=format&fit=crop&q=55&w=2400";

type PublicBookingPageProps = {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ preview?: string }>;
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
  paramsPromise,
}: {
  paramsPromise: Promise<{ slug: string }>;
}) {
  const { slug } = await paramsPromise;
  // P0.1 — resolve booking locale from cookie / Accept-Language.
  // Vietnam is the primary market so VI wins when no signal is set.
  const lang = await resolveBookingLanguage();
  const t = getBookingMessages(lang);

  const resolved = await resolvePublicBookingPage(slug);
  if (resolved.status === "reserved") {
    notFound();
  }

  if (resolved.status === "redirect") {
    redirect(resolved.to);
  }

  if (resolved.status === "not_found") {
    // BUG-07 (QA 2026-05-09): unknown slugs were returning HTTP 200 with a
    // salon-claim CTA, which Google indexed as thin/duplicate content.
    // notFound() makes Next render src/app/not-found.tsx with a 404 status.
    notFound();
  }

  const { load, normalizedSlug } = resolved;

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
  const isLightTheme = load.salon.themeMode === "light";
  const themeVars = isLightTheme
    ? {
        "--booking-bg": "#f9f9f9",
        "--booking-bg-card": "#ffffff",
        "--booking-bg-input": "#f2f2f2",
        "--booking-text": "#1a1a1a",
        "--booking-text-muted": "rgba(0, 0, 0, 0.45)",
        "--booking-border": "rgba(0, 0, 0, 0.1)",
        "--cta-bg": "#1a1a1a",
        "--cta-text": "#ffffff",
      }
    : {
        "--booking-bg": "#0a0a0a",
        "--booking-bg-card": "#1c1c1e",
        "--booking-bg-input": "#2c2c2e",
        "--booking-text": "#ffffff",
        "--booking-text-muted": "rgba(255, 255, 255, 0.5)",
        "--booking-border": "rgba(255, 255, 255, 0.1)",
        "--cta-bg": "#ffffff",
        "--cta-text": "#0a0a0a",
      };
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
  });

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
            src={DESKTOP_BOOKING_AMBIENT_SRC}
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

        <main className="relative z-10 mx-auto w-full max-w-[1200px] px-4 py-10 pb-safe sm:px-6 lg:flex lg:items-start lg:gap-10 lg:px-8 lg:py-14">
          <BookingSalonHero
            shopLabel={shopLabel}
            t={t}
            themeMode={load.salon.themeMode}
            address={load.salon.address}
            openingHoursRaw={load.salon.opening_hours}
            timezone={load.salon.timezone}
            description={load.salon.description}
            lang={lang}
            className="lg:sticky lg:top-10 lg:flex-shrink-0"
          />

          <div className="min-w-0 flex-1 lg:max-w-[min(100%,740px)] lg:pt-1">
            <BookingMobileHero
              shopLabel={shopLabel}
              t={t}
              themeMode={load.salon.themeMode}
              address={load.salon.address}
              openingHoursRaw={load.salon.opening_hours}
              timezone={load.salon.timezone}
              description={load.salon.description}
              lang={lang}
            />
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
                combos={load.combos}
                staff={load.staff}
                salon={load.salon}
                capabilityRows={load.capabilityRows}
                categories={await loadServiceCategories()}
                language={lang}
                voiceAiEnabled={load.salon.voiceAiEnabled}
              />
            </BookingFlowErrorBoundary>
          </div>
        </main>

        {/* P1.4 — AI chat widget; only renders when ANTHROPIC_API_KEY is set */}
        {process.env.ANTHROPIC_API_KEY ? (
          <BookingChatWidget salonId={load.salon.id} t={t} />
        ) : null}

        <div className="mx-auto w-full max-w-[1200px] px-4 pb-8 text-center sm:px-6 lg:px-8">
          <a
            href={`/${normalizedSlug}/gift`}
            className="inline-flex items-center gap-1.5 text-sm text-[var(--booking-text-muted)] hover:text-[var(--salon-primary)] transition-colors"
          >
            🎁 {t.giftCardPageLink}
          </a>
        </div>
      </div>
    </>
  );
}

export default async function PublicBookingPage({ params, searchParams }: PublicBookingPageProps) {
  const sp = await searchParams;
  const isPreview = sp?.preview === "true";

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
          <PublicBookingRouteBody paramsPromise={params} />
        </Suspense>
      </div>
    </>
  );
}
