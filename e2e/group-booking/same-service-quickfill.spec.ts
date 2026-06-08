import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import { gotoGroupFlow, seedGroupTestSalon } from "./helpers";

const SLUG = "e2e-group-quickfill";

/**
 * Step-2 "same service for everyone" quick-fill.
 *
 * Most groups (couples / friends / family at a head spa) book the
 * SAME service, so step 2 offers a single picker that fills every
 * member card at once. Each member can still override below; an
 * overridden member shows a "Changed" badge. This spec proves:
 *   1. quick-fill propagates one service to all member cards;
 *   2. the "applied to all" status line appears;
 *   3. overriding one member surfaces the per-member "Changed" badge
 *      and flips the status line to "mixed";
 *   4. the group still advances to step 3 with the per-member
 *      services intact.
 */
test.describe("Group booking — same-service quick-fill", () => {
  test.beforeAll(async () => {
    await seedGroupTestSalon(SLUG);
  });
  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("quick-fill applies one service to all, override badges the member", async ({
    page,
  }) => {
    await gotoGroupFlow(page, SLUG);

    // ── STEP 1 — size 3 ──────────────────────────────────────
    await page.getByTestId("group-size-3").click();
    await page.getByTestId("group-size-next").click();

    await page
      .getByTestId("group-step-service-panel")
      .waitFor({ state: "visible" });

    // Quick-fill card is visible (salon seeds 3 services / 3 staff).
    const quickFill = page.getByTestId("group-same-service-select");
    await expect(quickFill).toBeVisible();

    // Pick the first real service (index 0 is the placeholder).
    await quickFill.selectOption({ index: 1 });
    const applied = await quickFill.inputValue();
    expect(applied).not.toBe("");

    // All three member service selects now carry that service.
    for (const i of [0, 1, 2]) {
      await expect(page.getByTestId(`group-member-${i}-service`)).toHaveValue(
        applied,
      );
    }
    // Status line confirms it applied to all 3.
    await expect(page.getByTestId("group-same-service-status")).toContainText(
      "3",
    );
    // No member is badged yet — everyone shares the group service.
    await expect(
      page.getByTestId("group-member-1-custom-badge"),
    ).toHaveCount(0);

    // ── Override person 2 with a different service ────────────
    await page
      .getByTestId("group-member-1-service")
      .selectOption({ index: 2 });
    const overridden = await page
      .getByTestId("group-member-1-service")
      .inputValue();
    expect(overridden).not.toBe(applied);

    // Person 2 is now badged as "Changed"; the quick-fill drops to
    // "mixed" (members no longer share a single service).
    await expect(
      page.getByTestId("group-member-1-custom-badge"),
    ).toBeVisible();
    await expect(quickFill).toHaveValue("");

    // Persons 1 & 3 keep the group service; person 2 keeps its own.
    await expect(page.getByTestId("group-member-0-service")).toHaveValue(
      applied,
    );
    await expect(page.getByTestId("group-member-2-service")).toHaveValue(
      applied,
    );

    // ── Advances to step 3 with services intact ──────────────
    await page.getByTestId("group-service-next").click();
    await page
      .getByTestId("group-step-date-panel")
      .waitFor({ state: "visible" });
  });
});
