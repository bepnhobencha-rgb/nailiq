import { expect, test, type Page } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  rcSlug,
  seedReceptionistCenterFixture,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;

function shiftYmd(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
});

test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});

test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
});

async function expectCalmShell(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await gotoReceptionistCenter(page, fx.slug, {
    expectWalkinQueue: false,
    shellV2: true,
  });

  const shell = page.getByTestId("receptionist-center-loaded").last();
  await expect(shell).toHaveAttribute("data-receptionist-shell", "v2");
  await expect(shell).toHaveAttribute("data-receptionist-density", "pro");
  await expect(page.getByTestId("nailiq-suggestion-bar")).toBeVisible();
  await expect(page.getByTestId("viewed-date-chip")).not.toContainText(
    /\bToday\b/i,
  );
  await expect(page.getByTestId("date-switcher-today")).toBeVisible();
  await expect(page.getByTestId("nailiq-daily-brief-summary")).toHaveCount(0);
  await expect(page.getByTestId("receptionist-kpi-bar")).toHaveCount(0);
  await expect(page.getByTestId("receptionist-display-menu-trigger")).toHaveCount(0);
  await expect(page.getByTestId("header-add-walkin")).toHaveCount(0);
  await expect(page.getByTestId("header-add-appointment")).toHaveCount(0);
  await expect(page.getByTestId("header-add-group")).toHaveCount(0);

  const createTrigger =
    width < 640
      ? page.getByTestId("mobile-create-menu-trigger")
      : page.getByTestId("receptionist-create-trigger");
  await expect(createTrigger).toBeVisible();
  const box = await createTrigger.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);

  if (width >= 1280) {
    await expect(page.getByTestId("shell-v2-calendar-view-tabs")).toBeVisible();
    await expect(
      page.getByTestId("shell-v2-calendar-view-menu-trigger"),
    ).toBeHidden();
  } else {
    await expect(
      page.getByTestId("shell-v2-calendar-view-menu-trigger"),
    ).toBeVisible();
    await expect(page.getByTestId("shell-v2-calendar-view-tabs")).toBeHidden();
  }

  if (width >= 768) {
    const controlsBox = await page
      .getByTestId("dashboard-view-controls")
      .boundingBox();
    expect(controlsBox).not.toBeNull();
    const overlapsControls = !(
      box!.x + box!.width <= controlsBox!.x ||
      controlsBox!.x + controlsBox!.width <= box!.x ||
      box!.y + box!.height <= controlsBox!.y ||
      controlsBox!.y + controlsBox!.height <= box!.y
    );
    expect(overlapsControls).toBe(false);
  }

  await createTrigger.click();
  await expect(
    width < 640
      ? page.getByTestId("mobile-create-appointment")
      : page.getByTestId("create-menu-appointment"),
  ).toBeVisible();

  await expect(
    width < 640
      ? page.getByTestId("vertical-day-view")
      : page.getByTestId("staff-timeline-grid"),
  ).toBeVisible();
}

test.describe("Receptionist option-B shell", () => {
  test("desktop keeps the proven grid and one create entry", async ({ page }) => {
    await expectCalmShell(page, 1440, 900);
  });

  test("iPad keeps the proven grid and one create entry", async ({ page }) => {
    await expectCalmShell(page, 820, 1180);
  });

  test("mobile keeps the vertical schedule and one create entry", async ({ page }) => {
    await expectCalmShell(page, 390, 844);
  });

  test("desktop exposes day, week, and month without display settings", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoReceptionistCenter(page, fx.slug, {
      expectWalkinQueue: false,
      shellV2: true,
    });

    await page.getByTestId("shell-v2-calendar-view-week").click();
    await expect(page.getByTestId("week-view")).toBeVisible();

    await page.getByTestId("shell-v2-calendar-view-month").click();
    await expect(page.getByTestId("month-view")).toBeVisible();

    await page.getByTestId("shell-v2-calendar-view-day").click();
    await expect(page.getByTestId("staff-timeline-grid")).toBeVisible();
  });

  test("iPad calendar menu switches to the month overview", async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await gotoReceptionistCenter(page, fx.slug, {
      expectWalkinQueue: false,
      shellV2: true,
    });

    const trigger = page.getByTestId("shell-v2-calendar-view-menu-trigger");
    await expect(trigger).toBeVisible();
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(triggerBox!.height).toBeGreaterThanOrEqual(44);

    await trigger.click();
    await page.getByTestId("shell-v2-calendar-menu-month").click();
    await expect(page.getByTestId("month-view")).toBeVisible();
  });

  test("compact desktop calendar menu stays above the timeline", async ({ page }) => {
    await page.setViewportSize({ width: 1260, height: 500 });
    await gotoReceptionistCenter(page, fx.slug, {
      expectWalkinQueue: false,
      shellV2: true,
    });

    await page.getByTestId("shell-v2-calendar-view-menu-trigger").click();
    const month = page.getByTestId("shell-v2-calendar-menu-month");
    await expect(page.getByTestId("shell-v2-calendar-menu-day")).toBeVisible();
    await expect(page.getByTestId("shell-v2-calendar-menu-week")).toBeVisible();
    await expect(month).toBeVisible();

    const box = await month.boundingBox();
    expect(box).not.toBeNull();
    const topTestId = await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest<HTMLElement>("[data-testid]")
          ?.dataset.testid ?? null,
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    );
    expect(topTestId).toBe("shell-v2-calendar-menu-month");

    await month.click();
    await expect(page.getByTestId("month-view")).toBeVisible();
  });

  test("a day outside yesterday today tomorrow has no false active shortcut", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoReceptionistCenter(page, fx.slug, {
      expectWalkinQueue: false,
      shellV2: true,
    });

    await page.getByTestId("shell-v2-calendar-view-week").click();
    await page.getByTestId("week-view-next").click();
    await page
      .getByTestId(`week-view-day-button-${shiftYmd(fx.ymdUtc, 7)}`)
      .click();

    await expect(page.getByTestId("staff-timeline-grid")).toBeVisible();
    await expect(page.getByTestId("date-switcher-yesterday")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await expect(page.getByTestId("date-switcher-today")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await expect(page.getByTestId("date-switcher-tomorrow")).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });
});
