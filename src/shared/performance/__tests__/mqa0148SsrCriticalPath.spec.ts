import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("MQA-0148 SSR critical-path regression", () => {
  it("loads the verified public salon and catalog through one RLS-preserving snapshot", () => {
    const resolver = read(
      "src/shared/booking/resolvePublicBookingPage.ts",
    );
    const catalog = read("src/shared/booking/loadBookingServices.ts");
    const migration = read(
      "supabase/migrations/20260825103000_load_public_booking_snapshot.sql",
    );

    expect(resolver).toContain("loadPublicBookingSnapshot(");
    expect(resolver).toContain("publicSnapshotFlights");
    expect(resolver).toContain("loadDefaultPublicSnapshot");
    const proxy = read("src/proxy.ts");
    const publicBookingEarlyReturn = proxy.slice(
      proxy.indexOf("if (publicBookingPageLoad) {"),
      proxy.indexOf("let supabaseResponse"),
    );
    expect(publicBookingEarlyReturn).toContain(
      'consumeProxyLimit(request, "booking-page")',
    );
    expect(publicBookingEarlyReturn).toContain(
      "request: { headers: bookingDocumentRequestHeaders(request) }",
    );
    expect(resolver).toContain("snapshot.salon,");
    expect(resolver).toContain("snapshot,");
    expect(catalog).toContain("knownSalon?: Record<string, unknown>");
    expect(catalog).toContain("knownSnapshot?: PublicBookingSnapshot");
    expect(catalog).toContain('"load_public_booking_snapshot" as never');
    expect(migration).toContain("SECURITY INVOKER");
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.load_public_booking_snapshot[\s\S]*FROM PUBLIC;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.load_public_booking_snapshot[\s\S]*TO anon, authenticated, service_role;/,
    );
    expect(migration).not.toMatch(/p\.phone\b|p\.email\b|square_|stripe_/i);
    // Retain the direct-query fallback for scripts that inject a client on a
    // database that has not yet applied the candidate migration.
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
    const dashboardPage = read("src/app/dashboard/[slug]/page.tsx");
    const ownerHome = read(
      "src/shared/dashboard/loadOwnerHomeDashboardAction.ts",
    );
    const migration = read(
      "supabase/migrations/20260825103000_load_public_booking_snapshot.sql",
    );

    expect(dashboard).toMatch(
      /cache\(\s*resolveSalonForDashboardUncached\s*,?\s*\)/,
    );
    expect(dashboard).toContain("resolveSalonForDashboardInRender(slug)");
    expect(dashboard).toContain("dashboardAuthorizationFlights");
    expect(dashboard).toContain("dashboardAuthorizationFlightKey");
    expect(dashboard).toContain("dashboardProjectionFlights");
    expect(dashboard).toContain('createHash("sha256")');
    const proxy = read("src/proxy.ts");
    expect(proxy).toContain("proxyAuthFlights");
    expect(proxy).toContain("proxyAuthFlightKey(request)");
    expect(proxy).toContain("cookieWrites: [...cookieWrites]");
    expect(proxy).toContain("void flight.then(clear, clear)");
    expect(proxy).toContain("PROXY_AUTH_RETRY_DELAYS_MS");
    expect(dashboardPage).toContain("resolveSalonForDashboard(slug)");
    expect(dashboardPage).not.toContain('.from("salons")');
    expect(dashboard).toContain('"load_salon_dashboard_projection" as never');
    expect(dashboard).toMatch(
      /const supabase = createServiceRoleClient\(\);[\s\S]*load_salon_dashboard_projection/,
    );
    expect(ownerHome).toContain('"load_owner_home_projection" as never');
    expect(ownerHome).toContain("ownerHomeProjectionFlights");
    expect(ownerHome).toContain("resolved.salon.currency_code");
    expect(ownerHome).not.toContain('.from("salons")');
    expect(migration).toMatch(
      /load_salon_dashboard_projection[\s\S]*REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated;[\s\S]*TO service_role;/,
    );
    expect(migration).toMatch(
      /load_owner_home_projection[\s\S]*REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated;[\s\S]*TO service_role;/,
    );
  });
});
