/**
 * DRC lateness escalation + no-show tombstone + charge/waive decision.
 *
 * The fixture salon has `auto_no_show_minutes = null` (auto OFF) so:
 *   - lateness tiers use the FIXED 10/20-minute milestones (deterministic), and
 *   - the auto-mark cron skips this salon, so a seeded confirmed-late booking
 *     stays confirmed for the duration of the test (no mid-test status flip).
 *
 * Late bookings are seeded relative to real "now" (the grid compares against the
 * live clock); all seeds go on `freeStaffId` to avoid the baseline GIST overlap.
 */
import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  rcSlug,
  seedDeskBooking,
  seedReceptionistCenterFixture,
  testClientNameMarker,
  getBookingRow,
  supabaseAdmin,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;

/** ISO for a booking that started `min` minutes before real now (+ a 45m span). */
function lateStart(min: number): { startIso: string; endIso: string } {
  const start = Date.now() - min * 60_000;
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(start + 45 * 60_000).toISOString(),
  };
}

/** Seed a confirmed booking `min` minutes late on the free staff column. */
async function seedLate(min: number, status: "confirmed" | "completed" = "confirmed") {
  const { startIso, endIso } = lateStart(min);
  const name = testClientNameMarker();
  const id = await seedDeskBooking(fx.salonId, {
    clientName: name,
    serviceId: fx.serviceIds[0]!,
    staffId: fx.freeStaffId,
    startIso,
    endIso,
    status,
    clientPhone: "6045550111",
  });
  return id;
}

/** Stamp Square card-on-file fields so the no-show fee decision is offered. */
async function attachCard(bookingId: string, feeCents = 2500) {
  const { error } = await supabaseAdmin
    .from("bookings")
    .update({
      noshow_card_id: "ccof_e2e_test",
      noshow_customer_id: "cust_e2e_test",
      noshow_fee_cents: feeCents,
      noshow_charge_status: "saved",
    } as never)
    .eq("id", bookingId);
  if (error) throw new Error(`attachCard: ${error.message}`);
}

async function readChargeStatus(bookingId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("bookings")
    .select("noshow_charge_status")
    .eq("id", bookingId)
    .maybeSingle();
  const v = (data as { noshow_charge_status?: string | null } | null)?.noshow_charge_status;
  return v ?? null;
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

test.describe("DRC lateness escalation", () => {
  test("due tier (≤10m late): ring only, no clock icon, Start button shown", async ({ page }) => {
    const id = await seedLate(3);
    await gotoReceptionistCenter(page, fx.slug);

    await expect(page.getByTestId(`booking-block-lateness-${id}`)).toBeAttached();
    // due stays calm — no clock marker in the icon stack.
    await expect(page.getByTestId(`booking-block-icon-late-${id}`)).toHaveCount(0);
    // owner (demo cookie) can change status → inline Start is offered.
    await expect(page.getByTestId(`booking-block-start-${id}`)).toBeAttached();
  });

  test("late tier (10–20m): ring + amber clock icon", async ({ page }) => {
    const id = await seedLate(13);
    await gotoReceptionistCenter(page, fx.slug);

    await expect(page.getByTestId(`booking-block-lateness-${id}`)).toBeAttached();
    await expect(page.getByTestId(`booking-block-icon-late-${id}`)).toBeAttached();
  });

  test("critical tier (≥20m): ring + clock icon", async ({ page }) => {
    const id = await seedLate(23);
    await gotoReceptionistCenter(page, fx.slug);

    await expect(page.getByTestId(`booking-block-lateness-${id}`)).toBeAttached();
    await expect(page.getByTestId(`booking-block-icon-late-${id}`)).toBeAttached();
  });

  test("completed booking past start shows NO lateness escalation", async ({ page }) => {
    const id = await seedLate(13, "completed");
    await gotoReceptionistCenter(page, fx.slug);

    await expect(page.getByTestId(`booking-block-${id}`)).toBeAttached();
    await expect(page.getByTestId(`booking-block-lateness-${id}`)).toHaveCount(0);
    await expect(page.getByTestId(`booking-block-start-${id}`)).toHaveCount(0);
  });

  test("inline Start flips confirmed → in_progress and clears the escalation", async ({ page }) => {
    const id = await seedLate(13);
    await gotoReceptionistCenter(page, fx.slug);

    const startBtn = page.getByTestId(`booking-block-start-${id}`);
    await startBtn.evaluate((el: HTMLElement) => el.click());

    await expect
      .poll(async () => (await getBookingRow(fx.salonId, id))?.status, { timeout: 15_000 })
      .toBe("in_progress");
    // Escalation ring is gone once the service has started.
    await expect(page.getByTestId(`booking-block-lateness-${id}`)).toHaveCount(0);
  });
});

test.describe("DRC no-show tombstone + fee decision", () => {
  async function seedNoShow(opts: { withCard: boolean }) {
    const { startIso, endIso } = lateStart(30);
    const name = testClientNameMarker();
    const id = await seedDeskBooking(fx.salonId, {
      clientName: name,
      serviceId: fx.serviceIds[0]!,
      staffId: fx.freeStaffId,
      startIso,
      endIso,
      status: "confirmed",
      clientPhone: "6045550111",
    });
    if (opts.withCard) await attachCard(id);
    const { error } = await supabaseAdmin
      .from("bookings")
      .update({ status: "no_show" } as never)
      .eq("id", id);
    if (error) throw new Error(`seedNoShow: ${error.message}`);
    return id;
  }

  test("no-show renders a tombstone with an Undo action", async ({ page }) => {
    const id = await seedNoShow({ withCard: false });
    await gotoReceptionistCenter(page, fx.slug);

    const tomb = page.getByTestId(`noshow-tombstone-${id}`);
    await expect(tomb).toBeAttached();
    await tomb.evaluate((el: HTMLElement) => el.click());
    await expect(page.getByRole("button", { name: /undo no-show/i })).toBeVisible();
  });

  test("tombstone Waive sets the fee to 'waived' (no charge)", async ({ page }) => {
    const id = await seedNoShow({ withCard: true });
    await gotoReceptionistCenter(page, fx.slug);

    const tomb = page.getByTestId(`noshow-tombstone-${id}`);
    await tomb.evaluate((el: HTMLElement) => el.click());

    const waive = page.getByRole("button", { name: /waive fee/i });
    await expect(waive).toBeVisible();
    await waive.click();

    await expect
      .poll(() => readChargeStatus(id), { timeout: 15_000 })
      .toBe("waived");
  });

  test("marking no-show with a card on file opens the Charge/Waive modal (not an instant mark)", async ({ page }) => {
    const id = await seedLate(13);
    await attachCard(id);
    await gotoReceptionistCenter(page, fx.slug);

    await page.getByTestId(`booking-block-${id}`).evaluate((el: HTMLElement) => el.click());
    await expect(page.getByTestId("booking-detail-drawer")).toBeVisible();

    // Drawer "No-show" action → fee modal intercepts before marking.
    await page.getByRole("button", { name: /^no-show$/i }).click();

    // The modal title is unique ("No-show fee"); avoid getByRole("dialog")
    // since the drawer is also a dialog.
    await expect(page.getByText(/^no-show fee$/i)).toBeVisible();
    // Still confirmed — the modal gates the decision, nothing marked yet.
    expect((await getBookingRow(fx.salonId, id))?.status).toBe("confirmed");

    // Choose Waive → booking becomes no_show + fee 'waived'.
    await page.getByRole("button", { name: /^waive fee$/i }).click();
    await expect
      .poll(async () => (await getBookingRow(fx.salonId, id))?.status, { timeout: 15_000 })
      .toBe("no_show");
    await expect.poll(() => readChargeStatus(id), { timeout: 15_000 }).toBe("waived");
  });
});
