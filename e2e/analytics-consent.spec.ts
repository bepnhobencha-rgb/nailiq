import { expect, test } from "@playwright/test";
import {
  cleanupClientProfile,
  cleanupTestSalon,
  gotoBookingServiceStep,
  seedTestSalon,
} from "./helpers/db";
import {
  advanceBookingStep,
  selectAvailableBookingDate,
} from "./helpers/bookingFlow";

test("analytics is opt-in, reversible, and never sends raw route identity", async ({
  context,
  page,
}) => {
  const googleRequests: string[] = [];
  await context.route("https://www.googletagmanager.com/**", async (route) => {
    googleRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
  });

  await page.goto("/?ref=private-referral&tryon=private-session");
  await expect(page.getByTestId("analytics-consent-banner")).toBeVisible();
  await expect(page.locator("#nailiq-ga")).toHaveCount(0);
  expect(googleRequests).toHaveLength(0);

  await page.getByTestId("analytics-consent-deny").click();
  await expect(page.getByTestId("analytics-consent-banner")).toHaveCount(0);
  await expect(page.getByTestId("analytics-consent-manage")).toBeVisible();
  await expect(page.locator("#nailiq-ga")).toHaveCount(0);
  expect(googleRequests).toHaveLength(0);

  await page.getByTestId("analytics-consent-manage").click();
  await page.getByTestId("analytics-consent-grant").click();
  await expect(page.locator("#nailiq-ga")).toHaveCount(1);
  await expect.poll(() => googleRequests.length).toBe(1);

  const commands = await page.evaluate(() =>
    (
      (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? []
    ).map((entry: unknown) => Array.from(entry as ArrayLike<unknown>)),
  );
  const serialized = JSON.stringify(commands);
  expect(serialized).toContain("send_page_view");
  expect(serialized).toContain("allow_ad_personalization_signals");
  expect(serialized).toContain("page_view");
  expect(serialized).not.toContain("private-referral");
  expect(serialized).not.toContain("private-session");

  await page.getByTestId("analytics-consent-manage").click();
  await page.getByTestId("analytics-consent-deny").click();
  const disabled = await page.evaluate(
    () => (window as unknown as Record<string, unknown>)["ga-disable-G-TEST123"],
  );
  expect(disabled).toBe(true);
});

test("completed individual booking emits an ordered, allowlisted funnel", async ({
  context,
  page,
}) => {
  const slug = "e2e-analytics-consent";
  const phone = "16045552642";
  await seedTestSalon({ slug, phone: "16045552641", name: "Analytics QA Salon" });
  await context.addInitScript(() => {
    window.localStorage.setItem("nailiq-analytics-consent-v1", "granted");
  });
  await context.route("https://www.googletagmanager.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
  );

  try {
    await gotoBookingServiceStep(page, slug, { phone, name: "Analytics Guest" });
    await page.locator('[data-testid="service-tile-select"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    const staff = page.locator('[data-testid="staff-item"]').first();
    await expect(staff).toBeVisible();
    await staff.click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    await selectAvailableBookingDate(page);
    await page.getByRole("button", { name: "Continue" }).first().click();

    const firstSlot = page.locator('[data-testid="time-slot"]:not([disabled])').first();
    await expect(firstSlot).toBeVisible({ timeout: 20_000 });
    await firstSlot.click();
    await advanceBookingStep(
      page.getByRole("group", { name: "Choose a time" }),
      page.getByTestId("booking-info-name"),
    );

    await page.getByRole("button", { name: "Continue" }).first().click();
    const confirmConsent = page.getByTestId("sms-consent");
    if (await confirmConsent.isVisible().catch(() => false)) {
      await confirmConsent.check();
    }
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByTestId("booking-success")).toBeVisible({
      timeout: 20_000,
    });

    const commands = await page.evaluate(() =>
      (
        (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? []
      ).map((entry: unknown) => Array.from(entry as ArrayLike<unknown>)),
    );
    const serialized = JSON.stringify(commands);
    expect(serialized).toContain("booking_funnel_open");
    expect(serialized).toContain("booking_funnel_progress");
    expect(serialized).toContain("service_selected");
    expect(serialized).toContain("booking_submit_attempt");
    expect(serialized).toContain("booking_complete");
    expect(serialized).not.toContain(slug);
    expect(serialized).not.toContain(phone);
    expect(serialized).not.toContain("Analytics Guest");

    const funnel = commands
      .filter((command) => command[0] === "event")
      .map((command) => ({
        name: command[1],
        step: (command[2] as { funnel_step?: string } | undefined)?.funnel_step,
      }))
      .filter((event) => String(event.name).startsWith("booking_"));
    const open = funnel.findIndex((event) => event.name === "booking_funnel_open");
    const serviceSelected = funnel.findIndex(
      (event) => event.step === "service_selected",
    );
    const submit = funnel.findIndex((event) => event.name === "booking_submit_attempt");
    const complete = funnel.findIndex((event) => event.name === "booking_complete");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(serviceSelected).toBeGreaterThan(open);
    expect(submit).toBeGreaterThan(serviceSelected);
    expect(complete).toBeGreaterThan(submit);
  } finally {
    await cleanupTestSalon(slug);
    await cleanupClientProfile(phone);
  }
});
