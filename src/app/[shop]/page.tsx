import type { Metadata } from "next";
import { BookingFlow } from "@/components/booking/BookingFlow";
import { bookingEn } from "@/shared/i18n/booking/en";
import { BookingDocumentEn } from "./BookingDocumentEn";

type ShopPageProps = {
  params: Promise<{ shop: string }>;
};

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

  return (
    <>
      <BookingDocumentEn />
      <main className="mx-auto min-h-dvh w-full max-w-lg px-4 py-10 pb-safe sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground sm:text-3xl">
          {t.pageTitle}
        </h1>
        <p className="mt-1 text-sm text-nq-muted sm:text-base">
          {t.pageSubtitle}—{shop}
        </p>
        <BookingFlow t={t} shopSlug={shop} />
      </main>
    </>
  );
}
