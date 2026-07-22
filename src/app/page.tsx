import type { Metadata } from "next";
import { Inter, Playfair_Display } from "next/font/google";
import { LandingNavbar } from "@/components/landing/LandingNavbar";
import { LandingHero } from "@/components/landing/LandingHero";
import { LandingPainSection } from "@/components/landing/LandingPainSection";
import { LandingFeatures } from "@/components/landing/LandingFeatures";
import { LandingKeepPos } from "@/components/landing/LandingKeepPos";
import { LandingTrustStrip } from "@/components/landing/LandingTrustStrip";
import { LandingPricing } from "@/components/landing/LandingPricing";
import { LandingFAQ } from "@/components/landing/LandingFAQ";
import { LandingFinalCta } from "@/components/landing/LandingFinalCta";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { getLandingJsonLd } from "@/shared/seo/jsonLd";

const landingInter = Inter({
  subsets: ["latin", "vietnamese"],
  variable: "--font-landing-inter",
  display: "swap",
});

const landingPlayfair = Playfair_Display({
  weight: "700",
  style: ["italic"],
  subsets: ["latin", "vietnamese"],
  variable: "--font-landing-playfair",
  display: "swap",
});

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
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
      />
      <div
        className={`${landingInter.variable} ${landingPlayfair.variable} min-h-screen bg-nq-bg text-nq-foreground antialiased font-[family-name:var(--font-landing-inter),system-ui,-apple-system,sans-serif]`}
      >
        <LandingNavbar />
        <main>
          <LandingHero />
          <LandingTrustStrip />
          <LandingPainSection />
          <LandingFeatures />
          <LandingKeepPos />
          <LandingPricing />
          <LandingFAQ />
          <LandingFinalCta />
        </main>
        <LandingFooter />
      </div>
    </>
  );
}
