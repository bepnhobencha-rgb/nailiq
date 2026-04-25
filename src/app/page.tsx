import type { Metadata } from "next";
import { MarketingHome } from "@/components/user/MarketingHome";
import { getLandingJsonLd } from "@/shared/seo/jsonLd";

const landingDescription =
  "NailIQ helps nail salons get booked automatically with AI-powered booking, website, automation, and customer growth tools.";

const landingTitle = "Clients book you, even when you're fully booked | NailIQ";

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
      <MarketingHome />
    </>
  );
}
