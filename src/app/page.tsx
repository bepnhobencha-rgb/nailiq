import type { Metadata } from "next";
import { Inter, Playfair_Display } from "next/font/google";
import { LandingNavbar } from "@/components/landing/LandingNavbar";
import { LandingHero } from "@/components/landing/LandingHero";
import { LandingPainSection } from "@/components/landing/LandingPainSection";
import { LandingFeatures } from "@/components/landing/LandingFeatures";
import { LandingHowItWorks } from "@/components/landing/LandingHowItWorks";
import { LandingSocialProof } from "@/components/landing/LandingSocialProof";
import { LandingPricing } from "@/components/landing/LandingPricing";
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
  "Built for nail salons. $29/month. 3–5× cheaper than Booksy. Vietnamese-first booking, walk-in queue, and live receptionist center.";

const landingTitle = "NailIQ — Booking + walk-in queue for nail salons";

export const metadata: Metadata = {
  title: landingTitle,
  description: landingDescription,
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
        </main>
        <LandingFooter />
      </div>
    </>
  );
}
