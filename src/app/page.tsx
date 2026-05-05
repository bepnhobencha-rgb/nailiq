import type { Metadata } from "next";
import { Inter, Playfair_Display } from "next/font/google";
import { HomeLanding } from "@/components/user/HomeLanding";
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
  "NailIQ helps nail salons stop losing money from missed calls—get bookings in minutes without another app.";

const landingTitle = "NailIQ — Stop losing money from missed calls";

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
        className={`${landingInter.variable} ${landingPlayfair.variable}`}
      >
        <HomeLanding />
      </div>
    </>
  );
}
