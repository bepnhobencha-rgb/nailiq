import { expect, test } from "@playwright/test";
import path from "node:path";

import { cleanupTestSalon, seedTestSalon } from "./helpers/db";

const SLUG = "e2e-nail-tryon-camera";
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

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

    await expect(page.getByRole("alert")).toContainText(
      "Camera access is unavailable",
    );
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
    await expect(page.getByRole("alert")).toContainText("Four fingers saved");
    await expect(page.getByText("Thumb", { exact: true })).toBeVisible();

    await page.getByLabel("Choose an existing photo").setInputFiles(fixture);
    await expect(page.getByAltText("Your hand photo preview")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retake" })).toBeVisible();
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
