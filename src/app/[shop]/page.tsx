import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookingFlow } from "@/components/booking/BookingFlow";
import { BookingSalonHero } from "@/components/booking/BookingSalonHero";
import { loadBookingServicesForSalonSlug } from "@/shared/booking/loadBookingServices";
import { bookingEn } from "@/shared/i18n/booking/en";
import { BookingDocumentEn } from "./BookingDocumentEn";

/** Soft ambient layer behind split layout (`lg:`); matches hero imagery tone. */
const DESKTOP_BOOKING_AMBIENT_SRC =
  "https://images.unsplash.com/photo-1610992015732-2449b76344bc?auto=format&fit=crop&q=55&w=2400";

type ShopPageProps = {
  params: Promise<{ shop: string }>;
};

function decodeShopSegment(shop: string): string {
  try {
    return decodeURIComponent(shop);
  } catch {
    return shop;
  }
}

export async function generateMetadata({
  params,
}: ShopPageProps): Promise<Metadata> {
  const { shop } = await params;
  const label = decodeURIComponent(shop);
  return {
    title: `Book ${label}`,
    description: `Book nail and beauty appointments at ${label}. English-only guest experience on NailIQ.`,
  };
}

export default async function ShopBookingPage({ params }: ShopPageProps) {
  const { shop } = await params;
  const t = bookingEn;

  const load = await loadBookingServicesForSalonSlug(shop);
  if (load === null) {
    notFound();
  }

  const shopLabel = decodeShopSegment(shop);

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
            <BookingFlow
              t={t}
              shopSlug={shop}
              services={load.services}
              staff={load.staff}
              salon={load.salon}
            />
          </div>
        </main>
      </div>
    </>
  );
}
