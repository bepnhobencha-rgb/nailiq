import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  cleanupClientProfile,
  cleanupTestSalon,
  enterBookingPhone,
  seedTestSalon,
} from "./helpers/db";
import {
  advanceBookingStep,
  selectAvailableBookingDate,
} from "./helpers/bookingFlow";

const SLUG = "e2e-booking-zoom-a11y";
const GUEST_PHONE_DIGITS = "16045550935";
const EFFECTIVE_200_PERCENT_ZOOM = { width: 195, height: 422 };

async function assertCriticalTextIsReadable(
  root: Locator,
  label: string,
): Promise<void> {
  await root.waitFor({ state: "visible", timeout: 15_000 });

  const result = await root.evaluate((element) => {
    const candidates = Array.from(
      element.querySelectorAll<HTMLElement>(
        "h1, h2, h3, legend, label, button, p, [role=alert]",
      ),
    );
    const visible = candidates.filter((candidate) => {
      const style = window.getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return (
        candidate.textContent?.trim() &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    });

    const clipped = visible.flatMap((candidate) => {
        const style = window.getComputedStyle(candidate);
        const clipsX = style.overflowX === "hidden" || style.overflowX === "clip";
        const clipsY = style.overflowY === "hidden" || style.overflowY === "clip";
        if (!clipsX && !clipsY) return [];

        // scrollWidth includes absolutely-positioned decorative sheen/pseudo
        // elements. A DOM Range measures the real text content only.
        const range = document.createRange();
        range.selectNodeContents(candidate);
        const textRect = range.getBoundingClientRect();
        const rect = candidate.getBoundingClientRect();
        const textIsClipped =
          (clipsX && (textRect.left < rect.left - 1 || textRect.right > rect.right + 1)) ||
          (clipsY && (textRect.top < rect.top - 1 || textRect.bottom > rect.bottom + 1));
        if (!textIsClipped) return [];

        return [{
          text: candidate.textContent?.trim().slice(0, 120),
          elementRect: {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          },
          textRect: {
            left: textRect.left,
            right: textRect.right,
            top: textRect.top,
            bottom: textRect.bottom,
          },
          overflowX: style.overflowX,
          overflowY: style.overflowY,
        }];
      });

    const tooSmall = visible
      .filter((candidate) => Number.parseFloat(window.getComputedStyle(candidate).fontSize) < 8)
      .map((candidate) => candidate.textContent?.trim().slice(0, 120));

    return { visibleTextCount: visible.length, clipped, tooSmall };
  });

  expect(result.visibleTextCount, `${label} must expose readable text`).toBeGreaterThan(0);
  expect(result.clipped, `${label} has clipped critical text`).toEqual([]);
  expect(
    result.tooSmall,
    `${label} has text below 8 CSS px (16 physical px at the effective 200% zoom)`,
  ).toEqual([]);
}

async function assertColorContrast(
  page: Page,
  selector: string,
  label: string,
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withRules(["color-contrast"])
    .analyze();

  const failures = results.violations.flatMap((violation) =>
    violation.nodes.map((node) => ({
      target: node.target.join(" "),
      summary: node.failureSummary,
    })),
  );
  expect(failures, `${label} has WCAG color-contrast violations`).toEqual([]);
}

async function auditStep(
  page: Page,
  selector: string,
  label: string,
): Promise<Locator> {
  const root = page.locator(selector);
  await assertCriticalTextIsReadable(root, label);
  await assertColorContrast(page, selector, label);
  return root;
}

test.describe("MQA-0035 — public booking remains readable at 200% zoom", () => {
  test.beforeEach(async () => {
    await cleanupClientProfile(GUEST_PHONE_DIGITS);
    await seedTestSalon({
      slug: SLUG,
      name: "E2E Zoom Accessibility Salon",
      phone: "15553334444",
    });
  });

  test.afterEach(async () => {
    await cleanupTestSalon(SLUG);
    await cleanupClientProfile(GUEST_PHONE_DIGITS);
  });

  test("phone through confirmation remain readable, unclipped and operable", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "The deterministic effective-zoom audit runs once in Chromium",
    );

    // A 195 CSS px layout displayed at the normal 390 physical px mobile
    // width is the deterministic browser-automation equivalent of 200% zoom.
    // It exercises the reflow pressure without relying on OS/browser chrome.
    await page.setViewportSize(EFFECTIVE_200_PERCENT_ZOOM);
    await page.goto(`/${SLUG}`);
    await page.getByTestId("booking-entry-hydrated").waitFor({
      state: "attached",
      timeout: 15_000,
    });

    const viewportMeta = await page
      .locator('meta[name="viewport"]')
      .getAttribute("content");
    expect(viewportMeta ?? "").not.toMatch(/user-scalable\s*=\s*no/i);
    expect(viewportMeta ?? "").not.toMatch(/maximum-scale\s*=\s*(?:0|1)(?:\.0+)?(?:\s|,|$)/i);

    await assertCriticalTextIsReadable(page.locator("#book"), "phone entry");
    await enterBookingPhone(page, GUEST_PHONE_DIGITS);
    await expect(page.getByTestId("booking-entry-name")).toBeVisible();
    await assertCriticalTextIsReadable(page.locator("#book"), "new guest entry");
    await assertColorContrast(page, "#book", "new guest entry");

    await page.getByTestId("booking-entry-name").fill("Zoom QA Guest");
    await page.getByTestId("sms-consent").check();

    const service = await auditStep(
      page,
      'section[aria-labelledby="svc-heading"]',
      "service step",
    );
    await service.locator('[data-testid="service-tile-select"]').first().click();
    await advanceBookingStep(
      service,
      page.locator('section[aria-labelledby="staff-heading"]'),
    );

    const staff = await auditStep(
      page,
      'section[aria-labelledby="staff-heading"]',
      "staff step",
    );
    await staff.locator('[data-testid="staff-item"]').first().click();
    await advanceBookingStep(
      staff,
      page.locator('section[aria-labelledby="date-heading"]'),
    );

    const date = await auditStep(
      page,
      'section[aria-labelledby="date-heading"]',
      "date step",
    );
    await selectAvailableBookingDate(page);
    await advanceBookingStep(
      date,
      page.locator('section[aria-labelledby="time-heading"]'),
    );

    const time = await auditStep(
      page,
      'section[aria-labelledby="time-heading"]',
      "time step",
    );
    const slot = time.locator('[data-testid="time-slot"]:not([disabled])').first();
    await slot.click();
    await expect(slot).toHaveAttribute("aria-pressed", "true");
    await advanceBookingStep(time, page.getByTestId("booking-info-name"));

    const info = await auditStep(
      page,
      'section[aria-labelledby="info-heading"]',
      "information step",
    );
    await page.getByTestId("booking-info-name").fill("Zoom QA Guest");
    await advanceBookingStep(
      info,
      page.getByTestId("confirm-booking-btn"),
    );

    const confirm = await auditStep(
      page,
      'section[aria-labelledby="conf-heading"]',
      "confirmation step",
    );
    const confirmButton = confirm.getByTestId("confirm-booking-btn");
    await confirmButton.scrollIntoViewIfNeeded();
    await expect(confirmButton).toBeVisible();
    await expect(confirmButton).toBeEnabled();

    // Stop before submit: this typography gate must not create a booking or
    // invoke any notification/payment provider.
  });
});
