import type { Metadata } from "next";
import { MarketingHome } from "@/components/user/MarketingHome";
import { getLandingJsonLd } from "@/shared/seo/jsonLd";

const landingDescription =
  "NailIQ helps nail salons get booked automatically with AI-powered booking, website, automation, and customer growth tools.";

export const metadata: Metadata = {
  title: "Stop losing clients | NailIQ",
  description: landingDescription,
  openGraph: {
    title: "Stop losing clients | NailIQ",
    description: landingDescription,
  },
  twitter: {
    title: "Stop losing clients | NailIQ",
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
      <MarketingHome />
    </>
  );
}
