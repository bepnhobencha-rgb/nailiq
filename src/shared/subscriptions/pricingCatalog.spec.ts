import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { getLandingJsonLd } from "@/shared/seo/jsonLd";
import {
  PUBLIC_SUBSCRIPTION_PRICES,
  PUBLIC_TRIAL_DAYS,
  decimalAmountFromCents,
  formatCadAmount,
  formatPublicMonthlyPrice,
} from "./pricingCatalog";

describe("public subscription pricing catalog", () => {
  it("keeps the approved self-service price points explicit", () => {
    expect(PUBLIC_TRIAL_DAYS).toBe(14);
    expect(PUBLIC_SUBSCRIPTION_PRICES.pro).toMatchObject({
      marketingName: "Core",
      monthlyAmountCents: 3_900,
      currency: "CAD",
      stripePriceEnvKey: "STRIPE_PRICE_PRO",
    });
    expect(PUBLIC_SUBSCRIPTION_PRICES.premium).toMatchObject({
      marketingName: "Studio",
      monthlyAmountCents: 9_900,
      currency: "CAD",
      stripePriceEnvKey: "STRIPE_PRICE_PREMIUM",
    });
  });

  it("formats deterministic display and structured-data amounts", () => {
    expect(formatPublicMonthlyPrice("pro")).toBe("$39");
    expect(formatPublicMonthlyPrice("premium", { includeCurrency: true })).toBe(
      "$99 CAD",
    );
    expect(formatCadAmount(3_950)).toBe("$39.50");
    expect(decimalAmountFromCents(3_900)).toBe("39.00");
  });

  it("keeps the static llms surface free of copied prices", () => {
    const llms = readFileSync(resolve(process.cwd(), "public/llms.txt"), "utf8");

    expect(llms).toContain("https://www.nailiq.ca/#pricing");
    expect(llms).not.toContain("$39 CAD");
    expect(llms).not.toContain("$99 CAD");
    expect(llms).not.toContain("$89 CAD");
  });

  it("publishes only the Core offer visible on the landing page", () => {
    const jsonLd = getLandingJsonLd();
    const software = jsonLd["@graph"].find(
      (entry) => entry["@type"] === "SoftwareApplication",
    );

    expect(software).toBeDefined();
    expect(software?.offers).toHaveLength(1);
    expect(software?.offers?.[0]).toMatchObject({
      name: "NailIQ Core",
      price: "39.00",
      priceCurrency: "CAD",
      priceSpecification: {
        price: "39.00",
        priceCurrency: "CAD",
        unitText: "MONTH",
      },
    });
  });

  it("keeps public runtime surfaces on the canonical catalog", () => {
    const runtimeSurfaces = [
      "src/app/opengraph-image.tsx",
      "src/app/terms/page.tsx",
      "src/components/dashboard/LoyaltySetupClient.tsx",
      "src/components/dashboard/PricingPanel.tsx",
      "src/components/landing/LandingPricing.tsx",
      "src/shared/i18n/user/en.ts",
      "src/shared/i18n/user/vi.ts",
      "src/shared/seo/jsonLd.ts",
    ];

    for (const path of runtimeSurfaces) {
      const source = readFileSync(resolve(process.cwd(), path), "utf8");
      expect(source, path).toContain("pricingCatalog");
    }

    const jsonLd = readFileSync(
      resolve(process.cwd(), "src/shared/seo/jsonLd.ts"),
      "utf8",
    );
    const envExample = readFileSync(
      resolve(process.cwd(), ".env.example"),
      "utf8",
    );

    expect(jsonLd).not.toContain("Founder Pilot Monthly");
    expect(jsonLd).not.toContain('price: "1399"');
    expect(jsonLd).not.toContain("PUBLIC_SUBSCRIPTION_PRICES.premium");
    expect(envExample).not.toContain("Pro = $39");
    expect(envExample).toContain("pricingCatalog.ts");

    const pricingPanel = readFileSync(
      resolve(process.cwd(), "src/components/dashboard/PricingPanel.tsx"),
      "utf8",
    );
    expect(pricingPanel).toContain("PUBLIC_SUBSCRIPTION_PRICES[plan].marketingName");
  });
});
