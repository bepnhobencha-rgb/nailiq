import { getSiteUrl } from "./site";

const DESCRIPTION =
  "AI-powered booking, automation, and growth system for nail salons. Get more bookings, reduce missed calls, and automate your salon.";

export function getLandingJsonLd() {
  const siteUrl = getSiteUrl();

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${siteUrl}/#organization`,
        name: "NailIQ",
        url: siteUrl,
        description: DESCRIPTION,
      },
      {
        "@type": "WebSite",
        "@id": `${siteUrl}/#website`,
        name: "NailIQ",
        url: siteUrl,
        description: DESCRIPTION,
        publisher: { "@id": `${siteUrl}/#organization` },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${siteUrl}/#software`,
        name: "NailIQ",
        description: DESCRIPTION,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url: siteUrl,
        publisher: { "@id": `${siteUrl}/#organization` },
        audience: {
          "@type": "Audience",
          audienceType: "Nail salons and beauty businesses",
        },
      },
    ],
  };
}
