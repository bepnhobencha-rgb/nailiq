import { expect, test } from "@playwright/test";

const STATUS_CAPABILITY_ID = "11111111-1111-4111-8111-111111111111";

test("an unscheduled waiting walk-in sees a valid status instead of an expired-link error", async ({
  page,
}) => {
  await page.route(`**/api/booking/status?token=${STATUS_CAPABILITY_ID}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "private, no-store, max-age=0" },
      body: JSON.stringify({
        ok: true,
        code: "valid",
        booking: {
          status: "waiting",
          startTimeUtc: null,
          endTimeUtc: null,
          serviceName: "QA Nail Service",
          staffName: null,
          salonSlug: "qa-salon",
          salonName: "QA Salon",
          salonTimezone: "America/Los_Angeles",
          scheduleModel: "single",
          sequenceReceipt: null,
        },
        turnIqEta: null,
      }),
    });
  });

  await page.goto(`/booking/status?token=${STATUS_CAPABILITY_ID}`);

  await expect(page.getByRole("heading", { name: "Appointment Status" })).toBeVisible();
  await expect(page.getByText("waiting", { exact: true })).toBeVisible();
  await expect(page.getByText("QA Nail Service", { exact: true })).toBeVisible();
  await expect(page.getByText(
    "You are on the walk-in list. The salon will assign your time.",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText("This status link is invalid or has expired.")).toHaveCount(0);
});
