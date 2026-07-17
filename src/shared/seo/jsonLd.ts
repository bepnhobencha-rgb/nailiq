import { getSiteUrl } from "./site";
import { resolveVertical } from "@/shared/verticals/registry";

const DESCRIPTION =
  "Done-for-you website, booking and salon operations setup for nail salons. Works alongside Square, Clover, Toast or another POS.";

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
          "Done-for-you website, online booking, staff scheduling and salon operations for nail salons. Compatible with Square, Clover, Toast or another POS.",
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "Salon Management Software",
        operatingSystem: "Web",
        url: siteUrl,
        publisher: { "@id": `${siteUrl}/#organization` },
        audience: {
          "@type": "Audience",
          audienceType: "Nail salons",
        },
        featureList: [
          "Done-for-you salon website (template-based)",
          "Online appointment booking",
          "Staff scheduling and availability",
          "Booking policies and OTP",
          "Works alongside Square, Clover, Toast or another POS",
          "Square connection assistance where supported",
          "Vietnamese-friendly support",
        ],
        offers: [
          {
            "@type": "Offer",
            name: "Founder Pilot Monthly",
            price: "99",
            priceCurrency: "CAD",
            priceSpecification: {
              "@type": "UnitPriceSpecification",
              price: "99",
              priceCurrency: "CAD",
              unitText: "MONTH",
            },
            description:
              "Founder Pilot Monthly: $499 CAD setup plus $99 CAD/month. Minimum six-month commitment. Excludes applicable taxes and third-party fees.",
          },
          {
            "@type": "Offer",
            name: "Founder Pilot Annual",
            price: "1399",
            priceCurrency: "CAD",
            priceSpecification: {
              "@type": "UnitPriceSpecification",
              price: "1399",
              priceCurrency: "CAD",
              unitText: "ANN",
            },
            description:
              "Founder Pilot Annual: $1,399 CAD covering setup and 12 months. Excludes applicable taxes and third-party fees.",
          },
        ],
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
  /** `salons.vertical` — selects the schema.org business type. Falls back to
   *  the nail-salon default when null/unknown. */
  vertical?: string | null;
};

export function getSalonLocalBusinessJsonLd({
  slug,
  name,
  description,
  address,
  phone,
  timezone,
  vertical,
}: SalonLocalBusinessInput) {
  const siteUrl = getSiteUrl();
  const pageUrl = `${siteUrl}/${slug}`;

  return {
    "@context": "https://schema.org",
    "@type": resolveVertical(vertical).schemaType,
    "@id": `${pageUrl}/#salon`,
    name,
    url: pageUrl,
    priceRange: "$$",
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
