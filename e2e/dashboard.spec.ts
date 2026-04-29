import { test, expect, request } from "@playwright/test";

import { cleanupTestSalon, seedTestSalon } from "./helpers/db";

test("Middleware blocks unauthenticated dashboard access", async ({ page }) => {
  await page.goto("/dashboard/any-salon");
  await expect(page).toHaveURL(/register/);
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
    expect(res.headers().location ?? "").toMatch(/register/i);
  } finally {
    await req.dispose();
  }
});
