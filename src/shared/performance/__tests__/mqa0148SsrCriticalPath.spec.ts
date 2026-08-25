import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("MQA-0148 SSR critical-path regression", () => {
  it("reuses the verified public salon and keeps catalog reads in two waves", () => {
    const resolver = read(
      "src/shared/booking/resolvePublicBookingPage.ts",
    );
    const catalog = read("src/shared/booking/loadBookingServices.ts");

    expect(resolver).toMatch(
      /loadBookingServicesForSalonSlug\([\s\S]*normalizedSlug,[\s\S]*client,[\s\S]*exists,/,
    );
    expect(catalog).toContain("knownSalon?: Record<string, unknown>");
    expect(catalog).toContain("servicesQuery,");
    expect(catalog).toContain("staffQuery,");
    expect(catalog).toContain("promotionsQuery,");
    expect(catalog).toContain("combosQuery,");
    expect(catalog).toContain("resourcesQuery,");
    expect(catalog).toContain("await Promise.all([");
    expect(catalog).toContain("capabilityResult, rulesResult");
  });

  it("starts optional public-page reads together instead of awaiting serially", () => {
    const page = read("src/app/[slug]/page.tsx");

    expect(page).toContain("serviceCategories,");
    expect(page).toContain("] = await Promise.all([");
    expect(page).toContain("loadPublicNailTryOnSalon(normalizedSlug)");
    expect(page).toContain("categories={serviceCategories}");
    expect(page).not.toContain("categories={await loadServiceCategories()}");
  });

  it("deduplicates dashboard authorization per render and reuses salon metadata", () => {
    const dashboard = read("src/shared/dashboard/salonOwnerActions.ts");
    const ownerHome = read(
      "src/shared/dashboard/loadOwnerHomeDashboardAction.ts",
    );

    expect(dashboard).toMatch(
      /cache\(\s*resolveSalonForDashboardUncached\s*,?\s*\)/,
    );
    expect(dashboard).toContain("resolveSalonForDashboardInRender(slug)");
    expect(dashboard).toContain(
      "bookingsResult, servicesCountResult, staffCountResult",
    );
    expect(ownerHome).toContain("resolved.salon.currency_code");
    expect(ownerHome).not.toContain('.from("salons")');
  });
});
