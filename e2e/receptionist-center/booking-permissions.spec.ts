import { expect, test, type Page } from "@playwright/test";

import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestUser,
} from "../helpers/db";
import { waitForReceptionistHydration } from "../helpers/receptionistHydration";
import {
  rcSlug,
  seedReceptionistCenterFixture,
  supabaseAdmin,
  type ReceptionistCenterFixture,
} from "./helpers";

type TestMember = {
  userId: string;
  email: string;
  password: string;
  role: SalonMemberRole;
};

let fx: ReceptionistCenterFixture;
let members: TestMember[] = [];

async function seedMember(role: SalonMemberRole): Promise<TestMember> {
  const user = await seedTestUser();
  const { error } = await supabaseAdmin.from("salon_members").insert({
    salon_id: fx.salonId,
    user_id: user.userId,
    role,
  });
  if (error) {
    await cleanupTestUser(user.userId);
    throw new Error(`seed ${role} membership: ${error.message}`);
  }
  return { ...user, role };
}

async function loginAndOpenCenter(page: Page, member: TestMember): Promise<void> {
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(member.email);
  await page.locator('input[type="password"]').fill(member.password);
  await page.getByTestId("password-signin-submit").click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });

  await page.goto(
    `/dashboard/${encodeURIComponent(fx.slug)}/center?date=${fx.ymdUtc}`,
  );
  await page
    .getByTestId("receptionist-center-loaded")
    .first()
    .waitFor({ state: "attached", timeout: 45_000 });
  await waitForReceptionistHydration(page, fx.slug);
}

async function openBaselineBooking(page: Page): Promise<void> {
  await page
    .getByTestId(`booking-block-${fx.displayApptBookingId}`)
    .click();
  await expect(page.getByTestId("booking-detail-drawer")).toBeVisible();
}

async function openCreateAppointment(page: Page): Promise<void> {
  const desktopControl = page.getByTestId("header-add-appointment");
  if (await desktopControl.isVisible()) {
    await desktopControl.click();
    return;
  }

  const mobileMenu = page.getByTestId("mobile-create-menu-trigger");
  await expect(mobileMenu).toBeVisible();
  await mobileMenu.click();
  await page.getByTestId("mobile-create-appointment").click();
}

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
  members = await Promise.all(
    (["owner", "admin", "receptionist", "nail_tech"] as const).map(seedMember),
  );
});

test.afterAll(async ({}, testInfo) => {
  for (const member of members) {
    await cleanupTestUser(member.userId);
  }
  await cleanupTestSalon(rcSlug(testInfo.project.name));
});

for (const role of ["owner", "admin", "receptionist"] as const) {
  test(`${role} can access booking create, edit, cancel, and status actions`, async ({
    page,
  }) => {
    const member = members.find((candidate) => candidate.role === role);
    if (!member) throw new Error(`missing ${role} fixture`);

    await loginAndOpenCenter(page, member);
    await openCreateAppointment(page);
    const bookingForm = page.getByTestId("desk-booking-form");
    await expect(bookingForm).toBeVisible();
    await bookingForm.getByRole("button", { name: "Close" }).click();
    await expect(bookingForm).toHaveCount(0);

    await openBaselineBooking(page);
    await expect(page.getByTestId("edit-booking-button")).toBeVisible();
    await expect(page.getByTestId("drawer-cancel-booking")).toBeVisible();
    await expect(page.getByTestId("drawer-primary-action")).toBeVisible();
  });
}

test("nail tech cannot access booking create, edit, cancel, or another tech's status actions", async ({
  page,
}) => {
  const member = members.find((candidate) => candidate.role === "nail_tech");
  if (!member) throw new Error("missing nail_tech fixture");

  await loginAndOpenCenter(page, member);
  await expect(
    page.locator(
      '[data-testid="header-add-appointment"], [data-testid="mobile-create-menu-trigger"], [data-testid="mobile-create-appointment"]',
    ),
  ).toHaveCount(0);
  await expect(page.getByTestId("header-add-walkin")).toHaveCount(0);

  await openBaselineBooking(page);
  await expect(page.getByTestId("edit-booking-button")).toHaveCount(0);
  await expect(page.getByTestId("drawer-cancel-booking")).toHaveCount(0);
  await expect(page.getByTestId("drawer-primary-action")).toHaveCount(0);
});
