import type { Metadata } from "next";
import { Inter, Playfair_Display } from "next/font/google";
import { LandingNavbar } from "@/components/landing/LandingNavbar";
import { LandingHero } from "@/components/landing/LandingHero";
import { LandingPainSection } from "@/components/landing/LandingPainSection";
import { LandingFeatures } from "@/components/landing/LandingFeatures";
import { LandingKeepPos } from "@/components/landing/LandingKeepPos";
import { LandingHowItWorks } from "@/components/landing/LandingHowItWorks";
import { LandingTrustStrip } from "@/components/landing/LandingTrustStrip";
import { LandingPricing } from "@/components/landing/LandingPricing";
import { LandingPosScope } from "@/components/landing/LandingPosScope";
import { LandingClearScope } from "@/components/landing/LandingClearScope";
import { LandingSmsFairUse } from "@/components/landing/LandingSmsFairUse";
import { LandingPaymentDisclaimer } from "@/components/landing/LandingPaymentDisclaimer";
import { LandingWhyJoin } from "@/components/landing/LandingWhyJoin";
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
          {/* 1. Hero — Founder Pilot eyebrow + POS reassurance in the trust line */}
          <LandingHero />
          <LandingTrustStrip />
          {/* 2. Problem — pain points NailIQ + implementation solves */}
          <LandingPainSection />
          {/* 3. Done-For-You — the 7-card what's-included grid */}
          <LandingFeatures />
          {/* 4. Keep Your POS — Square / Clover-Toast-other / Custom cards */}
          <LandingKeepPos />
          {/* 5. How It Works — 4 steps */}
          <LandingHowItWorks />
          {/* 6. Founder Pilot Pricing — Monthly + Annual (BEST VALUE) */}
          <LandingPricing />
          {/* 7. POS Compatibility — 3-column included/supported/not-included */}
          <LandingPosScope />
          {/* 8. Clear Scope — exhaustive out-of-scope list + hourly rates */}
          <LandingClearScope />
          {/* 9. SMS Fair Use — 250 segments/mo, no unlimited claim */}
          <LandingSmsFairUse />
          {/* 10. Payment Provider Notice — Square/Clover/Toast independence */}
          <LandingPaymentDisclaimer />
          {/* 11. Why Join — pilot-only benefits + renewal-price notice */}
          <LandingWhyJoin />
          {/* 12. FAQ — 16 questions covering the pilot scope */}
          <LandingFAQ />
          {/* 13. Final CTA — apply / demo + legal note */}
          <LandingFinalCta />
        </main>
        <LandingFooter />
      </div>
    </>
  );
}
