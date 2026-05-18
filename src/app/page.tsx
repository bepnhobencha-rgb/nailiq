import type { Metadata } from "next";
import { Inter, Playfair_Display } from "next/font/google";
import { LandingNavbar } from "@/components/landing/LandingNavbar";
import { LandingHero } from "@/components/landing/LandingHero";
import { LandingPainSection } from "@/components/landing/LandingPainSection";
import { LandingFeatures } from "@/components/landing/LandingFeatures";
import { LandingHowItWorks } from "@/components/landing/LandingHowItWorks";
import { LandingSocialProof } from "@/components/landing/LandingSocialProof";
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
  "AI-powered salon OS for nail salons. Vietnamese-first. Booking + walk-in queue + receptionist center. From $39/month — less than one manicure.";

const landingTitle =
  "NailIQ — AI-Powered Salon OS for Nail Salons | From $39/month";

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
    title: landingTitle,
    description: landingDescription,
  },
  twitter: {
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
          <LandingPainSection />
          <LandingFeatures />
          <LandingHowItWorks />
          <LandingSocialProof />
          <LandingPricing />
          <LandingFAQ />
          <LandingFinalCta />
        </main>
        <LandingFooter />
      </div>
    </>
  );
}
