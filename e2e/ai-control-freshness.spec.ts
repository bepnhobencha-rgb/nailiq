import { expect, test, type Page } from "@playwright/test";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalon,
  seedTestSalonMember,
} from "./helpers/db";

const SLUG = `e2e-ai-control-freshness-${process.env.GITHUB_RUN_ID ?? Date.now()}`;
let owner:
  | Awaited<ReturnType<typeof seedTestSalonMember>>
  | undefined;

async function loginAs(
  page: Page,
  account: { email: string; password: string },
) {
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByTestId("password-signin-submit").click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
}

test.describe("AI Control Center freshness", () => {
  test.beforeAll(async () => {
    const salon = await seedTestSalon({
      slug: SLUG,
      name: "AI Control Freshness Test Salon",
      phone: "15553339991",
      feature_flags: { ai_control_center_enabled: true },
    });
    owner = await seedTestSalonMember(salon.salonId, "owner");
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
    if (owner) await cleanupTestUser(owner.userId);
  });

  test("visible stale operating state refreshes through the authenticated route", async ({
    page,
  }) => {
    if (!owner) throw new Error("owner fixture missing");
    await loginAs(page, owner);
    await page.clock.install();

    await page.goto(`/dashboard/${SLUG}/ai`);
    await expect(
      page.getByRole("heading", { name: "AI Control Center" }),
    ).toBeVisible();
    await expect(page.getByTestId("ai-control-freshness")).toContainText(
      /updates every minute|tự cập nhật mỗi phút/i,
    );

    const refreshRequest = page.waitForRequest(
      (request) =>
        request.resourceType() === "document" &&
        request.method() === "GET" &&
        request.url().includes(`/dashboard/${SLUG}/ai`) &&
        !request.url().includes("_rsc="),
    );
    await page.clock.fastForward(60_000);
    await refreshRequest;

    await expect(page).toHaveURL(new RegExp(`/dashboard/${SLUG}/ai`));
    await expect(page.getByTestId("ai-control-freshness")).toBeVisible();
  });

  test("slow client navigation keeps App Router hook order stable", async ({
    page,
  }) => {
    if (!owner) throw new Error("owner fixture missing");
    await loginAs(page, owner);
    await page.goto(`/dashboard/${SLUG}`);

    await page.route(
      (url) =>
        url.pathname === `/dashboard/${SLUG}/ai` &&
        url.searchParams.has("_rsc"),
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 750));
        await route.continue();
      },
    );

    const aiLink = page.locator(
      `a[href="/dashboard/${SLUG}/ai"]`,
    ).first();
    await expect(aiLink).toHaveCount(1);
    await aiLink.evaluate((element: HTMLAnchorElement) => element.click());

    await expect(
      page.getByRole("heading", { name: "AI Control Center" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "This page couldn’t load" }),
    ).toHaveCount(0);
  });
});
