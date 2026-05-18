import { test, expect } from "./test";

import {
  cleanReceptionistData,
  gotoReceptionistCenter,
} from "./helpers";

test.beforeEach(async ({ rcFixture }) => {
  await cleanReceptionistData(rcFixture.salonId);
});

/**
 * Case 7 (automated slice): viewport ≤768px stacks queue above timeline (`order-1` / `order-2`).
 * Real iPad Safari behavior remains manual (see deliverables).
 */
test.describe("Mobile layout", () => {
  test("case 7: narrow viewport places walk-in form above timeline", async ({ page, rcFixture }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReceptionistCenter(page, rcFixture.slug);

    const form = page.getByTestId("walkin-add-form");
    const grid = page.getByTestId("staff-timeline-grid");

    await expect(form).toBeVisible();
    await expect(grid).toBeVisible();

    const formBox = await form.boundingBox();
    const gridBox = await grid.boundingBox();
    expect(formBox && gridBox).toBeTruthy();
    if (!formBox || !gridBox) return;

    expect(formBox.y).toBeLessThan(gridBox.y);
  });
});
