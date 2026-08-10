import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NailTryOnCapture } from "@/components/booking/NailTryOnCapture";
import { resolveBookingLanguage } from "@/shared/i18n/booking";
import { loadPublicNailTryOnSalon } from "@/shared/nailTryOn/publicSalon";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ lang?: string }>;
};

export const metadata: Metadata = {
  title: "AI Nail Try-On | NailIQ",
  description: "Preview a salon nail design on your own hand photo.",
  robots: { index: false, follow: false },
};

export default async function NailTryOnPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const query = await searchParams;
  const salon = await loadPublicNailTryOnSalon(slug);
  if (!salon) notFound();
  const language = query?.lang === "en" || query?.lang === "vi"
    ? query.lang
    : await resolveBookingLanguage();

  return (
    <main className="min-h-dvh bg-[#f6f4f1] px-4 py-8 sm:px-6 sm:py-12">
      <NailTryOnCapture
        salonName={salon.name}
        salonSlug={salon.slug}
        brandColor={salon.brandColor}
        language={language}
      />
    </main>
  );
}
