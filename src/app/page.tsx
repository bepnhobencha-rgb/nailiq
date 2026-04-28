import type { Metadata } from "next";
import { HomeLanding } from "@/components/user/HomeLanding";
import { getLandingJsonLd } from "@/shared/seo/jsonLd";

const landingDescription =
  "NailIQ helps nail salons get booked automatically with AI-powered booking, operations, and growth tools.";

const landingTitle = "NailIQ — Salon booking & operations";

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
      <HomeLanding />
    </>
  );
}
