import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { BookingFlow } from "@/components/booking/BookingFlow";
import { SalonBookingNotFound } from "@/components/booking/SalonBookingNotFound";
import { SalonBookingPaused } from "@/components/booking/SalonBookingPaused";
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
    return { title: "Not found | NailIQ" };
  }
  if (resolved.status === "redirect") {
    redirect(resolved.to);
  }
  if (resolved.status === "not_found") {
    return {
      title: "Create your booking link | NailIQ",
      description:
        "This salon page isn't set up yet. Start free and get your own booking link.",
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
    return (
      <SalonBookingNotFound
        requestedSlug={resolved.normalizedSlug}
        suggestedSlugs={resolved.suggestedSlugs}
      />
    );
  }

  const { load, normalizedSlug } = resolved;

  const shopLabel = formatSalonDisplayName({
    name: load.salon.name,
    slug: normalizedSlug,
  });

  if (!load.salon.acceptingBookings) {
    return (
      <>
        <BookingDocumentEn />
        <div className="relative min-h-dvh px-4 py-10 pb-safe sm:px-6 lg:px-8">
          <SalonBookingPaused shopLabel={shopLabel} t={t} />
        </div>
      </>
    );
  }

  return (
    <>
      <BookingDocumentEn />
      <div className="relative min-h-dvh">
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
          <div className="absolute inset-0 bg-[#0b0c10]/86 backdrop-blur-[3px]" />
        </div>

        <main className="relative z-10 mx-auto w-full max-w-[1200px] px-4 py-10 pb-safe sm:px-6 lg:flex lg:items-start lg:gap-10 lg:px-8 lg:py-14">
          <BookingSalonHero
            shopLabel={shopLabel}
            t={t}
            className="lg:sticky lg:top-10 lg:flex-shrink-0"
          />

          <div className="min-w-0 flex-1 lg:max-w-[min(100%,740px)] lg:pt-1">
            <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground sm:text-3xl lg:text-[2.125rem] lg:leading-[1.15] lg:tracking-[-0.035em]">
              {t.pageTitle}
            </h1>
            <p className="mt-2 text-sm text-nq-muted sm:text-base lg:mt-3 lg:text-[17px] lg:leading-relaxed">
              {t.pageSubtitle}—{shopLabel}
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
