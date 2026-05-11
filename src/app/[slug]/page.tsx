import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { BookingFlow } from "@/components/booking/BookingFlow";
import { SalonBookingPaused } from "@/components/booking/SalonBookingPaused";
import { BookingMobileHero } from "@/components/booking/BookingMobileHero";
import { BookingSalonHero } from "@/components/booking/BookingSalonHero";
import { SalonBookingSkeleton } from "@/components/booking/SalonBookingSkeleton";
import { BookingFlowErrorBoundary } from "@/components/booking/BookingFlowErrorBoundary";
import { resolvePublicBookingPage } from "@/shared/booking/resolvePublicBookingPage";
import { bookingEn } from "@/shared/i18n/booking/en";
import { formatSalonDisplayName } from "@/shared/lib/salonDisplay";
import { BookingDocumentEn } from "./BookingDocumentEn";

/** Avoid stale static segments for salons created after deploy. */
export const dynamic = "force-dynamic";

/** Soft ambient layer behind split layout (`lg:`); matches hero imagery tone. */
const DESKTOP_BOOKING_AMBIENT_SRC =
  "https://images.unsplash.com/photo-1610992015732-2449b76344bc?auto=format&fit=crop&q=55&w=2400";

type PublicBookingPageProps = {
  params: Promise<{ slug: string }>;
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
  return {
    title: `Book ${name}`,
    description: `Book nail and beauty appointments at ${name}. English-only guest experience on NailIQ.`,
  };
}

async function PublicBookingRouteBody({
  paramsPromise,
}: {
  paramsPromise: Promise<{ slug: string }>;
}) {
  const { slug } = await paramsPromise;
  const t = bookingEn;

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
  const isLightTheme = load.salon.themeMode === "light";
  const themeVars = isLightTheme
    ? {
        "--booking-bg": "#f9f9f9",
        "--booking-bg-card": "#ffffff",
        "--booking-bg-input": "#f2f2f2",
        "--booking-text": "#1a1a1a",
        "--booking-text-muted": "rgba(0, 0, 0, 0.45)",
        "--booking-border": "rgba(0, 0, 0, 0.1)",
      }
    : {
        "--booking-bg": "#0a0a0a",
        "--booking-bg-card": "#1c1c1e",
        "--booking-bg-input": "#2c2c2e",
        "--booking-text": "#ffffff",
        "--booking-text-muted": "rgba(255, 255, 255, 0.5)",
        "--booking-border": "rgba(255, 255, 255, 0.1)",
      };
  const brandStyle = {
    "--salon-primary": load.salon.brandColor,
    "--brand": load.salon.brandColor,
    ...themeVars,
    "--nq-luxury-cta-from": `color-mix(in srgb, ${load.salon.brandColor} 75%, white 25%)`,
    "--nq-luxury-cta-mid": load.salon.brandColor,
    "--nq-luxury-cta-to": `color-mix(in srgb, ${load.salon.brandColor} 70%, black 30%)`,
    "--shadow-nq-tile-selected": `0 0 0 1px ${load.salon.brandColor}, 0 18px 50px -20px rgba(0, 0, 0, 0.55), 0 0 40px -8px color-mix(in srgb, ${load.salon.brandColor} 35%, transparent)`,
  } as React.CSSProperties;

  if (!load.salon.acceptingBookings) {
    return (
      <>
        <BookingDocumentEn />
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
      <BookingDocumentEn />
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
            className="h-full w-full object-cover opacity-[0.18]"
          />
          <div className="absolute inset-0 backdrop-blur-[3px] bg-[color-mix(in_srgb,var(--booking-bg)_86%,transparent)]" />
        </div>

        <main className="relative z-10 mx-auto w-full max-w-[1200px] px-4 py-10 pb-safe sm:px-6 lg:flex lg:items-start lg:gap-10 lg:px-8 lg:py-14">
          <BookingSalonHero
            shopLabel={shopLabel}
            t={t}
            themeMode={load.salon.themeMode}
            className="lg:sticky lg:top-10 lg:flex-shrink-0"
          />

          <div className="min-w-0 flex-1 lg:max-w-[min(100%,740px)] lg:pt-1">
            <BookingMobileHero
              shopLabel={shopLabel}
              t={t}
              themeMode={load.salon.themeMode}
            />
            <h1 className="hidden lg:block text-2xl font-semibold tracking-tight text-nq-foreground sm:text-3xl lg:text-[2.125rem] lg:leading-[1.15] lg:tracking-[-0.035em]">
              {t.pageTitle}
            </h1>
            <p className="mt-4 text-sm text-nq-muted sm:text-base lg:mt-3 lg:text-[17px] lg:leading-relaxed">
              {t.pageSubtitle}
            </p>
            <BookingFlowErrorBoundary
              shopSlug={normalizedSlug}
              salon={load.salon}
            >
              <BookingFlow
                t={t}
                shopSlug={normalizedSlug}
                services={load.services}
                staff={load.staff}
                salon={load.salon}
                capabilityRows={load.capabilityRows}
              />
            </BookingFlowErrorBoundary>
          </div>
        </main>
      </div>
    </>
  );
}

export default function PublicBookingPage({ params }: PublicBookingPageProps) {
  return (
    <Suspense
      fallback={
        <>
          <BookingDocumentEn />
          <SalonBookingSkeleton />
        </>
      }
    >
      <PublicBookingRouteBody paramsPromise={params} />
    </Suspense>
  );
}
