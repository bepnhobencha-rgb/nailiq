import { getSiteUrl } from "./site";

const DESCRIPTION =
  "Salon management and booking platform for nail salons.";

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
        sameAs: [
          "https://www.instagram.com/nailiq.ca",
        ],
      },
      {
        "@type": "WebSite",
        "@id": `${siteUrl}/#website`,
        name: "NailIQ",
        url: siteUrl,
        description: DESCRIPTION,
        publisher: { "@id": `${siteUrl}/#organization` },
        potentialAction: {
          "@type": "SearchAction",
          target: { "@type": "EntryPoint", urlTemplate: `${siteUrl}/register` },
          "query-input": "required name=search_term_string",
        },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${siteUrl}/#software`,
        name: "NailIQ",
        description:
          "AI-powered salon OS for nail salons. Online booking, walk-in queue, receptionist center, automated SMS reminders, and client management — all in one platform.",
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "Salon Management Software",
        operatingSystem: "Web",
        url: siteUrl,
        publisher: { "@id": `${siteUrl}/#organization` },
        audience: {
          "@type": "Audience",
          audienceType: "Nail salons and beauty businesses",
        },
        featureList: [
          "Online appointment booking",
          "Walk-in queue management",
          "AI receptionist",
          "Automated SMS reminders",
          "Client profiles and history",
          "Staff scheduling",
          "Service catalog management",
          "Multi-language support (English and Vietnamese)",
        ],
        offers: {
          "@type": "Offer",
          price: "39",
          priceCurrency: "CAD",
          priceSpecification: {
            "@type": "UnitPriceSpecification",
            price: "39",
            priceCurrency: "CAD",
            unitText: "MONTH",
          },
          description: "Starter plan — full booking system from $39/month CAD",
        },
        inLanguage: ["en", "vi"],
      },
    ],
  };
}

type SalonLocalBusinessInput = {
  slug: string;
  name: string;
  description: string | null;
  address: string | null;
  phone: string | null;
  timezone: string;
};

export function getSalonLocalBusinessJsonLd({
  slug,
  name,
  description,
  address,
  phone,
  timezone,
}: SalonLocalBusinessInput) {
  const siteUrl = getSiteUrl();
  const pageUrl = `${siteUrl}/${slug}`;

  return {
    "@context": "https://schema.org",
    "@type": "NailSalon",
    "@id": `${pageUrl}/#salon`,
    name,
    url: pageUrl,
    ...(description && { description }),
    ...(address && {
      address: {
        "@type": "PostalAddress",
        streetAddress: address,
      },
    }),
    ...(phone && { telephone: phone }),
    ...(timezone && { hasMap: `https://maps.google.com/?q=${encodeURIComponent(name + (address ? ` ${address}` : ""))}` }),
    potentialAction: {
      "@type": "ReserveAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: pageUrl,
        actionPlatform: [
          "http://schema.org/DesktopWebPlatform",
          "http://schema.org/MobileWebPlatform",
        ],
      },
      result: {
        "@type": "Reservation",
        name: `Book appointment at ${name}`,
      },
    },
  };
}
