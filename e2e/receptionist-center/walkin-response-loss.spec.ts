import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  clickWalkinService,
  clickWalkinSubmit,
  fillWalkinGuestContact,
  gotoReceptionistCenter,
  rcSlug,
  seedReceptionistCenterFixture,
  supabaseAdmin,
  testClientNameMarker,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;

test.use({ serviceWorkers: "block" });

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
});

test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});

test.afterEach(async () => {
  await cleanReceptionistData(fx.salonId);
  const { error } = await supabaseAdmin
    .from("salons")
    .update({ walkin_auto_assign: false } as never)
    .eq("id", fx.salonId);
  if (error) throw new Error(error.message);
});

test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
});

test("a lost create response retries to the same committed walk-in", async ({ page }) => {
  await gotoReceptionistCenter(page, fx.slug);

  const clientName = testClientNameMarker();
  await fillWalkinGuestContact(page, clientName);
  await clickWalkinService(page, fx.serviceIds[0]!);
  await expect(page.getByTestId("walkin-availability-loading")).toHaveCount(0);

  let droppedCommittedResponse = false;
  await page.route(`**/dashboard/${fx.slug}/center**`, async (route) => {
    const request = route.request();
    if (droppedCommittedResponse || request.method() !== "POST") {
      await route.continue();
      return;
    }

    droppedCommittedResponse = true;
    await route.fetch();
    await route.abort("connectionreset");
  });

  await clickWalkinSubmit(page);

  await expect
    .poll(async () => {
      const { count, error } = await supabaseAdmin
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("salon_id", fx.salonId)
        .eq("client_name", clientName);
      if (error) throw new Error(error.message);
      return count ?? 0;
    })
    .toBe(1);

  expect(droppedCommittedResponse).toBe(true);
  await expect(
    page.getByTestId("walkin-add-form").locator('[role="alert"]'),
  ).toContainText(
    "NailIQ will not create a duplicate",
  );

  await page.unroute(`**/dashboard/${fx.slug}/center**`);
  await clickWalkinSubmit(page);
  await expect(page.getByTestId("walkin-submit-success")).toBeVisible();

  const { data, error } = await supabaseAdmin
    .from("bookings")
    .select("id, idempotency_key, source, status")
    .eq("salon_id", fx.salonId)
    .eq("client_name", clientName);
  if (error) throw new Error(error.message);

  expect(data).toHaveLength(1);
  expect(data?.[0]).toMatchObject({ source: "walkin", status: "waiting" });
  expect(data?.[0]?.idempotency_key).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test("an assignment race keeps the committed customer in the queue", async ({ page }) => {
  const { error: settingError } = await supabaseAdmin
    .from("salons")
    .update({ walkin_auto_assign: true } as never)
    .eq("id", fx.salonId);
  if (settingError) throw new Error(settingError.message);

  await gotoReceptionistCenter(page, fx.slug);
  const clientName = testClientNameMarker();
  await fillWalkinGuestContact(page, clientName);
  await clickWalkinService(page, fx.serviceIds[0]!);
  await expect(page.getByTestId("walkin-availability-card")).toHaveAttribute(
    "data-walkin-availability-state",
    "free",
  );
  await expect(page.getByTestId("walkin-submit")).toHaveAttribute(
    "data-walkin-mode",
    "immediate",
  );

  const now = Date.now();
  const blockerStart = new Date(now).toISOString();
  const blockerEnd = new Date(now + 90 * 60_000).toISOString();
  const blockerName = `${testClientNameMarker()}Blocker`;

  // The shared fixture contains fixed-time baseline appointments. Depending on
  // the CI wall clock, one can already cover "now" or begin inside this
  // 90-minute race window. Treat a technician who is busy now as blocked, and
  // end each synthetic blocker at their next appointment so the fixture itself
  // never violates the database's authoritative no-overlap constraint.
  const { data: activeBookings, error: activeBookingsError } =
    await supabaseAdmin
      .from("bookings")
      .select("staff_id, start_time_utc, end_time_utc")
      .eq("salon_id", fx.salonId)
      .in("status", ["pending", "confirmed", "in_progress"])
      .not("staff_id", "is", null)
      .lt("start_time_utc", blockerEnd)
      .gt("end_time_utc", blockerStart);
  if (activeBookingsError) throw new Error(activeBookingsError.message);

  const blockerRows = fx.staffIds.flatMap((staffId, index) => {
    const staffBookings = (activeBookings ?? [])
      .filter((booking) => booking.staff_id === staffId)
      .sort(
        (left, right) =>
          Date.parse(left.start_time_utc) - Date.parse(right.start_time_utc),
      );
    const busyNow = staffBookings.some(
      (booking) =>
        Date.parse(booking.start_time_utc) <= now &&
        Date.parse(booking.end_time_utc) > now,
    );
    if (busyNow) return [];

    const nextStart = staffBookings.find(
      (booking) => Date.parse(booking.start_time_utc) > now,
    )?.start_time_utc;
    const safeBlockerEnd = nextStart ?? blockerEnd;

    return [
      {
        salon_id: fx.salonId,
        service_id: fx.serviceIds[0]!,
        staff_id: staffId,
        client_name: `${blockerName}${index}`,
        client_phone: "6045551234",
        start_time_utc: blockerStart,
        end_time_utc: safeBlockerEnd,
        status: "confirmed",
        source: "appointment",
        price_cents: 4500,
      },
    ];
  });

  if (blockerRows.length > 0) {
    const { error: blockError } = await supabaseAdmin
      .from("bookings")
      .insert(blockerRows);
    if (blockError) throw new Error(blockError.message);
  }

  await clickWalkinSubmit(page);
  await expect(page.getByTestId("walkin-submit-success")).toContainText(
    "Customer saved to the waiting list",
  );

  const { data, error } = await supabaseAdmin
    .from("bookings")
    .select("id, status, staff_id, start_time_utc")
    .eq("salon_id", fx.salonId)
    .eq("client_name", clientName);
  if (error) throw new Error(error.message);

  expect(data).toHaveLength(1);
  expect(data?.[0]).toMatchObject({
    status: "waiting",
    staff_id: null,
    start_time_utc: null,
  });
});
