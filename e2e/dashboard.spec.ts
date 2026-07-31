import { test, expect, request } from "@playwright/test";

import { cleanupTestSalon, seedTestSalon } from "./helpers/db";

test("Middleware blocks unauthenticated dashboard access", async ({ page }) => {
  await page.goto("/dashboard/any-salon");
  // Unauthenticated dashboard access is bounced to /login (proxy.ts
  // "Unauthenticated guards"); sign-in, not registration, is the entry point.
  await expect(page).toHaveURL(/login/);
});

test("Dashboard responds when demo cookie matches slug", async () => {
  const { slug } = await seedTestSalon({
    phone: "15557778888",
    slug: "e2e-dashboard-salon",
    name: "E2E Dashboard Salon",
  });

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

  const req = await request.newContext({ baseURL });
  try {
    const res = await req.get(`/dashboard/${slug}`, {
      headers: {
        Cookie: `nailiq-demo-slug=${slug}`,
      },
    });

    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html.toLowerCase()).toMatch(/e2e dashboard salon/);
  } finally {
    await req.dispose();
    await cleanupTestSalon(slug);
  }
});

test("Owner home keeps mobile operations first and moves deep reports to Business", async ({
  page,
}) => {
  const { slug } = await seedTestSalon({
    phone: "15557778889",
    slug: "e2e-owner-mobile-home",
    name: "E2E Owner Mobile Home",
  });
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.context().addCookies([
      {
        name: "nailiq-demo-slug",
        value: slug,
        url: baseURL,
      },
    ]);
    await page.goto(`/dashboard/${slug}`);

    const staffStatus = page.getByTestId("owner-mobile-staff-status");
    await expect(staffStatus).toBeVisible();
    await expect(staffStatus).toContainText("Jenny");
    await expect(staffStatus).toContainText(/Available|Đang trống/);

    await expect(page.getByTestId("owner-deep-report-month")).toBeHidden();
    await expect(
      page.getByTestId("owner-deep-report-leaderboards"),
    ).toBeHidden();

    const businessLink = page.getByTestId("owner-mobile-business-link");
    await expect(businessLink).toBeVisible();
    await expect(businessLink).toHaveAttribute(
      "href",
      `/dashboard/${slug}/pulse`,
    );

    const linkBox = await businessLink.boundingBox();
    expect(linkBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  } finally {
    await cleanupTestSalon(slug);
  }
});

test("Settings uses one-hand iPhone groups without changing the desktop overview", async ({
  page,
}) => {
  const { slug } = await seedTestSalon({
    phone: "15557778890",
    slug: "e2e-owner-mobile-settings",
    name: "E2E Owner Mobile Settings",
  });
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

  try {
    await page.context().addCookies([
      {
        name: "nailiq-demo-slug",
        value: slug,
        url: baseURL,
      },
    ]);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/dashboard/${slug}/settings`);

    const mobileList = page.getByTestId("settings-mobile-list");
    await expect(mobileList).toBeVisible();
    await expect(page.getByTestId("settings-desktop-overview")).toBeHidden();

    const groups = mobileList.locator('[data-testid^="settings-mobile-group-"]');
    await expect(groups).toHaveCount(6);

    const firstRow = page.getByTestId("settings-mobile-row-operations-0");
    await expect(firstRow).toBeVisible();
    await expect(firstRow).toHaveAttribute(
      "href",
      `/dashboard/${slug}/setup/services`,
    );
    const firstRowBox = await firstRow.boundingBox();
    const firstGroupBox = await firstRow.locator("..").boundingBox();
    expect(firstRowBox?.height ?? 0).toBeGreaterThanOrEqual(48);
    expect(firstRowBox?.width ?? 0).toBeGreaterThanOrEqual(300);
    expect(
      Math.abs((firstRowBox?.width ?? 0) - (firstGroupBox?.width ?? 0)),
    ).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(mobileList).toBeHidden();
    await expect(page.getByTestId("settings-desktop-overview")).toBeVisible();
  } finally {
    await cleanupTestSalon(slug);
  }
});

test("Wrong demo cookie slug is rejected", async () => {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

  const req = await request.newContext({
    baseURL,
    maxRedirects: 0,
  });
  try {
    const res = await req.get("/dashboard/different-salon", {
      headers: {
        Cookie: "nailiq-demo-slug=wrong-salon",
      },
    });

    expect(res.status()).toBeGreaterThanOrEqual(300);
    // Wrong demo cookie → not authenticated → bounced to /login (see proxy.ts).
    expect(res.headers().location ?? "").toMatch(/login/i);
  } finally {
    await req.dispose();
  }
});
