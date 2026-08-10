import { expect, test } from "@playwright/test";

import { cleanupTestSalon, seedTestSalon } from "./helpers/db";

const SLUG = "e2e-nail-tryon-camera";

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

  test("keeps photo upload available when camera permission is denied", async ({ page }) => {
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

    const openCamera = page.getByRole("button", { name: /Open camera/i });
    await expect(openCamera).toHaveCount(1);
    await openCamera.click();

    await expect(page.getByRole("alert")).toContainText("Camera access is unavailable");
    await expect(page.getByRole("button", { name: "Take photo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose from library" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Open camera$/i })).toHaveCount(0);
  });
});
