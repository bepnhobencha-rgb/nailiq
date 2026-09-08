import type { Metadata } from "next";
import { LandingNavbar } from "@/components/landing/LandingNavbar";
import { LandingHero } from "@/components/landing/LandingHero";
import { LandingFeatures } from "@/components/landing/LandingFeatures";
import { LandingTrustStrip } from "@/components/landing/LandingTrustStrip";
import { LandingPricing } from "@/components/landing/LandingPricing";
import { LandingFAQ } from "@/components/landing/LandingFAQ";
import { LandingFinalCta } from "@/components/landing/LandingFinalCta";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { getLandingJsonLd } from "@/shared/seo/jsonLd";
import { serializeJsonLd } from "@/shared/seo/serializeJsonLd";

const landingDescription =
  "NailIQ provides done-for-you website, online booking, staff scheduling and salon setup. Keep using Square, Clover, Toast or your current POS.";

const landingTitle =
  "NailIQ | Website, Booking & Salon Setup for Nail Salons";

export const metadata: Metadata = {
  // Use absolute so the root template (`%s | NailIQ`) doesn't append a
  // duplicate "NailIQ" suffix to a title that already starts with "NailIQ".
  title: { absolute: landingTitle },
  description: landingDescription,
  alternates: {
    canonical: "/",
    languages: {
      "x-default": "/",
      en: "/",
      vi: "/",
    },
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "NailIQ",
    locale: "en_CA",
    title: landingTitle,
    description: landingDescription,
  },
  twitter: {
    card: "summary_large_image",
    title: landingTitle,
    description: landingDescription,
  },
};

export default function Home() {
  const schema = getLandingJsonLd();

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(schema) }}
      />
      <div
        className="min-h-screen bg-nq-bg text-nq-foreground antialiased font-[family-name:var(--font-landing-inter),system-ui,-apple-system,sans-serif]"
      >
        <LandingNavbar />
        <main>
          <LandingHero />
          <LandingTrustStrip />
          <LandingFeatures />
          <LandingPricing />
          <LandingFAQ />
          <LandingFinalCta />
        </main>
        <LandingFooter />
      </div>
    </>
  );
}
