import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

import {
  cleanupTestSalon,
  cleanupTestUser,
  getNailTryOnCatalogState,
  seedNailTryOnDraftDesigns,
  seedTestSalon,
  seedTestSalonMember,
} from "./helpers/db";

const SLUG = "e2e-nail-tryon-camera";
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

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

test.describe("Nail Try-On camera fallback", () => {
  test.beforeEach(async () => {
    await seedTestSalon({
      slug: SLUG,
      name: "E2E Nail Try-On Camera",
      feature_flags: { nail_tryon_enabled: true },
    });
  });

  test.afterEach(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("serves Try-On and its setup only to an enabled nail salon", async ({
    page,
  }) => {
    await page.goto(`/${SLUG}?lang=en`);
    await expect(
      page.getByRole("link", { name: /Try a nail look on your hand/i }),
    ).toBeVisible();

    await page
      .context()
      .addCookies([{ name: "nailiq-demo-slug", value: SLUG, url: BASE }]);
    await page.goto(`/dashboard/${SLUG}/setup/nail-tryon`);
    await expect(
      page.getByRole("heading", { name: "AI design catalog" }),
    ).toBeVisible();
  });

  test("keeps a four-design catalog private, then lets the owner preview and publish five", async ({
    page,
  }) => {
    const { salonId } = await seedTestSalon({
      slug: SLUG,
      name: "E2E Nail Try-On Catalog",
      feature_flags: { nail_tryon_enabled: true },
    });
    const owner = await seedTestSalonMember(salonId, "owner");
    try {
      await seedNailTryOnDraftDesigns(salonId, [
        "QA Cherry",
        "QA Pearl",
        "QA Gold",
        "QA Rose",
      ]);
      await loginAs(page, owner);
      await page.goto(`/dashboard/${SLUG}/setup/nail-tryon`);

      await expect(page.getByText("4/5 minimum designs")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Publish catalog" }),
      ).toBeDisabled();
      await page.getByRole("button", { name: "Preview as customer" }).click();
      await expect(
        page.getByRole("region", { name: "Customer catalog preview" }),
      ).toContainText("QA Cherry");
      await expect(await getNailTryOnCatalogState(salonId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "QA Cherry", is_active: false }),
        ]),
      );

      await seedNailTryOnDraftDesigns(salonId, ["QA Silver"]);
      await page.reload();
      await expect(page.getByText("5/5 minimum designs")).toBeVisible();
      const publish = page.getByRole("button", { name: "Publish catalog" });
      await expect(publish).toBeEnabled();
      await publish.click();
      await expect(page.getByRole("status")).toContainText(
        "5 designs are now live",
      );
      await expect(
        (await getNailTryOnCatalogState(salonId)).every(
          (design) => design.is_active,
        ),
      ).toBe(true);
    } finally {
      await cleanupTestUser(owner.userId);
    }
  });

  test("keeps photo upload available when camera permission is denied", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      });
      Object.defineProperty(navigator, "maxTouchPoints", {
        configurable: true,
        value: 5,
      });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            throw new DOMException("Permission denied", "NotAllowedError");
          },
        },
      });
    });

    await page.goto(`/${SLUG}/try-on`);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Continue" }).click();

    const openCamera = page.getByRole("button", { name: /Open camera/i });
    await expect(openCamera).toHaveCount(1);
    await openCamera.click();

    await expect(
      page.getByText("Camera access is unavailable", { exact: false }),
    ).toBeVisible();
    await expect(page.getByLabel("Take a new photo")).toBeVisible();
    await expect(page.getByLabel("Take a new photo")).toHaveAttribute(
      "capture",
      "environment",
    );
    await expect(page.getByLabel("Choose an existing photo")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Open camera$/i }),
    ).toHaveCount(0);

    const cameraChooser = page.waitForEvent("filechooser");
    await page.getByLabel("Take a new photo").click();
    await cameraChooser;

    const libraryChooser = page.waitForEvent("filechooser");
    await page.getByLabel("Choose an existing photo").click();
    await libraryChooser;
  });

  test("does not offer a misleading camera-file action on desktop", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            throw new DOMException("Permission denied", "NotAllowedError");
          },
        },
      });
    });

    await page.goto(`/${SLUG}/try-on`);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /Open camera/i }).click();

    await expect(page.getByLabel("Take a new photo")).toHaveCount(0);
    await expect(page.getByLabel("Choose an existing photo")).toBeVisible();
  });

  test("offers an easier 4+1 capture and combines both views locally", async ({
    page,
  }) => {
    await page.goto(`/${SLUG}/try-on`);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("button", { name: "One photo" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Easy 4+1" }).click();
    await expect(
      page.getByRole("button", { name: "Easy 4+1" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Four fingers", { exact: true })).toBeVisible();
    await expect(page.getByText("Thumb", { exact: true })).toBeVisible();

    const fixture = path.resolve(
      process.cwd(),
      "e2e/visual/visual-regression.spec.ts-snapshots/booking-desktop-chromium-linux.png",
    );
    await page.getByLabel("Choose an existing photo").setInputFiles(fixture);
    await expect(
      page.getByText("Four fingers saved", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("Thumb", { exact: true })).toBeVisible();

    await page.getByLabel("Choose an existing photo").setInputFiles(fixture);
    await expect(page.getByAltText("Your hand photo preview")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retake" })).toBeVisible();
  });

  test("keeps booking available when AI generation fails", async ({ page }) => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const designId = "22222222-2222-4222-8222-222222222222";
    await page.route("**/api/nail-tryon/upload", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ sessionId, quality: "pass" }),
      });
    });
    await page.route("**/api/nail-tryon/catalog?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          designs: [{
            id: designId,
            name: "QA Cherry",
            description: "QA only",
            version: 1,
            previewUrl: null,
          }],
        }),
      });
    });
    await page.route("**/api/nail-tryon/generate", async (route) => {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "provider_unavailable", retryable: true }),
      });
    });

    await page.goto(`/${SLUG}/try-on?lang=en`);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Continue" }).click();

    const fixture = path.resolve(
      process.cwd(),
      "e2e/visual/visual-regression.spec.ts-snapshots/booking-desktop-chromium-linux.png",
    );
    await page.getByLabel("Choose an existing photo").setInputFiles(fixture);
    await page.getByRole("button", { name: /Use (this photo|anyway)/i }).click();
    await page.getByRole("button", { name: /QA Cherry/i }).click();

    await expect(
      page.getByText("AI preview could not be created", { exact: false }),
    ).toBeVisible();
    const fallback = page.getByRole("link", {
      name: "Continue booking without a preview",
    });
    await expect(fallback).toBeVisible();
    await expect(fallback).toHaveAttribute("href", `/${SLUG}?lang=en`);
  });

  test("hides Try-On from a non-nail salon even when the rollout flag is on", async ({
    page,
  }) => {
    await seedTestSalon({
      slug: SLUG,
      name: "E2E Head Spa",
      vertical: "head_spa",
      feature_flags: { nail_tryon_enabled: true },
    });

    await page.goto(`/${SLUG}/try-on`);
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();

    await page.goto(`/${SLUG}?lang=en`);
    await expect(
      page.getByRole("link", { name: /Try a nail look on your hand/i }),
    ).toHaveCount(0);

    await page
      .context()
      .addCookies([{ name: "nailiq-demo-slug", value: SLUG, url: BASE }]);
    await page.goto(`/dashboard/${SLUG}/setup/nail-tryon`);
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "AI design catalog" }),
    ).toBeHidden();
  });
});
