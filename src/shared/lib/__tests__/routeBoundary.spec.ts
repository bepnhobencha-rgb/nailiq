import { describe, expect, it } from "vitest";

import { isRouteOrUnder, isRouteOrUnderAny } from "../routeBoundary";

/**
 * These assertions are a security boundary, not a formatting preference.
 *
 * The bug: src/proxy.ts gated the dashboard with
 * `pathname.startsWith("/dashboard")`, which also matches `/dashboard-abc` — a
 * legal salon slug (RESERVED_BOOKING_SLUGS reserves the exact word, not the
 * prefix). A salon that registered `dashboard-nails` had its public booking
 * page 307'd to /login, so its customers simply could not book.
 *
 * The fix must be exact in BOTH directions, and the second is the dangerous
 * one: loosening the match to let salon slugs through must not let anything
 * through that is genuinely under /dashboard. The "must still be protected"
 * block below is the one to read twice.
 */

describe("isRouteOrUnder — the route itself and everything under it", () => {
  it("matches the route exactly", () => {
    expect(isRouteOrUnder("/dashboard", "/dashboard")).toBe(true);
  });

  it("matches paths under the route", () => {
    expect(isRouteOrUnder("/dashboard/", "/dashboard")).toBe(true);
    expect(isRouteOrUnder("/dashboard/tech-nails", "/dashboard")).toBe(true);
    expect(
      isRouteOrUnder("/dashboard/tech-nails/setup/services", "/dashboard"),
    ).toBe(true);
  });

  it("does NOT match a longer sibling name", () => {
    // The whole bug, in four lines.
    expect(isRouteOrUnder("/dashboard-abc", "/dashboard")).toBe(false);
    expect(isRouteOrUnder("/dashboard-salon", "/dashboard")).toBe(false);
    expect(isRouteOrUnder("/dashboard123", "/dashboard")).toBe(false);
    expect(isRouteOrUnder("/dashboardish/x", "/dashboard")).toBe(false);
  });

  it("does not match an unrelated path", () => {
    expect(isRouteOrUnder("/tech-nails", "/dashboard")).toBe(false);
    expect(isRouteOrUnder("/", "/dashboard")).toBe(false);
    expect(isRouteOrUnder("", "/dashboard")).toBe(false);
  });

  it("does not match the route as a mid-path segment", () => {
    // /tech-nails/dashboard is a salon's page, not the operator dashboard.
    expect(isRouteOrUnder("/tech-nails/dashboard", "/dashboard")).toBe(false);
  });
});

describe("the dashboard auth gate must NOT be weakened", () => {
  // Read this block twice. Letting salon slugs through is worthless if it also
  // lets a real dashboard path slip past the guard.
  const stillProtected = [
    "/dashboard",
    "/dashboard/",
    "/dashboard/tech-nails",
    "/dashboard/tech-nails/center",
    "/dashboard/hilite-anaheim/setup/staff",
    "/dashboard/any-salon/settings",
  ];

  it.each(stillProtected)("%s is still behind the auth gate", (path) => {
    expect(isRouteOrUnder(path, "/dashboard")).toBe(true);
  });

  const nowPublic = [
    "/dashboard-abc",
    "/dashboard-nails",
    "/dashboard-salon-vip",
    "/dashboard123",
  ];

  it.each(nowPublic)("%s is a salon slug and reaches its booking page", (path) => {
    expect(isRouteOrUnder(path, "/dashboard")).toBe(false);
  });
});

describe("the same boundary bug existed on the other guards", () => {
  it("superadmin: real routes gated, lookalike slugs are not", () => {
    expect(isRouteOrUnder("/superadmin", "/superadmin")).toBe(true);
    expect(isRouteOrUnder("/superadmin/salons", "/superadmin")).toBe(true);
    // A salon could register this slug and be bounced to /superadmin/login.
    expect(isRouteOrUnder("/superadmin-abc", "/superadmin")).toBe(false);
  });

  it("auth/api exemption: real routes exempt, lookalike slugs are not", () => {
    expect(isRouteOrUnderAny("/auth/callback", ["/auth", "/api"])).toBe(true);
    expect(isRouteOrUnderAny("/api/booking/sms-confirm", ["/auth", "/api"])).toBe(
      true,
    );
    // These are salon slugs. They must NOT inherit the email-confirm exemption.
    expect(isRouteOrUnderAny("/auth-salon", ["/auth", "/api"])).toBe(false);
    expect(isRouteOrUnderAny("/api-nails", ["/auth", "/api"])).toBe(false);
  });
});
