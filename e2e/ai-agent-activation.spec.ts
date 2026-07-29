import { expect, test, type Page } from "@playwright/test";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalon,
  seedTestSalonMember,
} from "./helpers/db";

const SLUG = `e2e-ai-agent-activation-${process.env.GITHUB_RUN_ID ?? Date.now()}`;
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
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
}

test.describe("AI agent activation impact", () => {
  test.beforeAll(async () => {
    const salon = await seedTestSalon({
      slug: SLUG,
      name: "AI Agent Activation Test Salon",
      phone: "15553339992",
    });
    owner = await seedTestSalonMember(salon.salonId, "owner");
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
    if (owner) await cleanupTestUser(owner.userId);
  });

  test("owner must explicitly confirm customer outreach before it persists", async ({
    page,
  }) => {
    if (!owner) throw new Error("owner fixture missing");
    await loginAs(page, owner);
    await page.goto(`/dashboard/${SLUG}/settings`);

    const aiManagerCategory = page.getByTestId(
      "settings-category-cat-ai-manager",
    );
    const aiManagerCategoryToggle = aiManagerCategory.getByRole("button");
    await expect(aiManagerCategoryToggle).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await aiManagerCategoryToggle.click();
    await expect(aiManagerCategoryToggle).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.getByTestId("settings-ai-manager-hub")).toBeVisible();
    const winback = page.getByRole("switch", { name: /Win-back|Kéo khách/ });
    await expect(winback).not.toBeChecked();
    await expect(
      page.locator('[data-impact="customer_outreach"]').first(),
    ).toBeVisible();

    page.once("dialog", (dialog) => dialog.dismiss());
    await winback.click();
    await expect(winback).not.toBeChecked();

    page.once("dialog", (dialog) => dialog.accept());
    await winback.click();
    await expect(winback).toBeChecked();
    await expect(winback).toBeEnabled();

    await page.reload();
    const persistedWinback = page.getByRole("switch", {
      name: /Win-back|Kéo khách/,
    });
    await expect(persistedWinback).toBeChecked();

    await persistedWinback.click();
    await expect(persistedWinback).not.toBeChecked();
    await expect(persistedWinback).toBeEnabled();

    await page.reload();
    await expect(
      page.getByRole("switch", { name: /Win-back|Kéo khách/ }),
    ).not.toBeChecked();
  });
});
