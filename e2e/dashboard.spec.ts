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
