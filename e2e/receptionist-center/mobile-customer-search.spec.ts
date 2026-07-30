import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  isoAtUtcYmdHourMinute,
  rcSlug,
  seedDeskBooking,
  seedReceptionistCenterFixture,
  supabaseAdmin,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;
let searchClientName: string;
let searchClientPhone: string;

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
  const suffix = `${Math.floor(1_000_000 + Math.random() * 9_000_000)}`;
  searchClientName = `Te2eGuestSearch${suffix}`;
  searchClientPhone = `1555${suffix}`;

  const { error } = await supabaseAdmin.from("client_profiles").insert({
    phone: searchClientPhone,
    name: searchClientName,
  });
  if (error) throw new Error(`seed search client profile: ${error.message}`);
});

test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
  await supabaseAdmin
    .from("client_profiles")
    .delete()
    .eq("phone", searchClientPhone);
});

test("finds an existing customer on iPhone and opens a prefilled booking", async ({
  page,
}) => {
  await cleanReceptionistData(fx.salonId);
  await seedDeskBooking(fx.salonId, {
    clientName: searchClientName,
    clientPhone: searchClientPhone,
    serviceId: fx.serviceIds[0]!,
    staffId: fx.staffIds[0]!,
    startIso: isoAtUtcYmdHourMinute(fx.ymdUtc, 7, 0),
    endIso: isoAtUtcYmdHourMinute(fx.ymdUtc, 7, 55),
    status: "completed",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await gotoReceptionistCenter(page, fx.slug);

  const trigger = page.getByTestId("mobile-customer-search-trigger");
  await expect(trigger).toBeVisible();
  const triggerBox = await trigger.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(triggerBox!.width).toBeGreaterThanOrEqual(44);
  expect(triggerBox!.height).toBeGreaterThanOrEqual(44);

  await trigger.click();
  const dialog = page.getByTestId("mobile-customer-search");
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(390);
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(844);

  const input = page.getByTestId("mobile-customer-search-input");
  const inputFontSize = await input.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).fontSize),
  );
  expect(inputFontSize).toBeGreaterThanOrEqual(16);
  await input.fill(searchClientName.slice(-9));

  const result = page
    .getByTestId("mobile-customer-search-result")
    .filter({ hasText: searchClientName });
  await expect(result).toBeVisible();
  const resultBox = await result.boundingBox();
  expect(resultBox).not.toBeNull();
  expect(resultBox!.height).toBeGreaterThanOrEqual(44);
  await result.click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("desk-booking-form")).toBeVisible();
  await expect(page.getByTestId("desk-client-name")).toHaveValue(searchClientName);
  await expect(page.getByTestId("desk-client-phone")).toHaveValue(
    searchClientPhone,
  );
});
