/**
 * DRC lateness escalation + no-show tombstone + charge/waive decision.
 *
 * The fixture salon has `auto_no_show_minutes = null` (auto OFF) so:
 *   - lateness tiers use the FIXED 10/20-minute milestones (deterministic), and
 *   - the review cron skips this salon, so no candidate flag appears.
 *
 * Late bookings are seeded relative to real "now" (the grid compares against the
 * live clock); all seeds go on `freeStaffId` to avoid the baseline GIST overlap.
 */
import { test, expect, type Page } from "@playwright/test";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalonMember,
} from "../helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  isoAtUtcYmdHourMinute,
  rcSlug,
  seedDeskBooking,
  seedReceptionistCenterFixture,
  testClientNameMarker,
  getBookingRow,
  supabaseAdmin,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;
let owner: Awaited<ReturnType<typeof seedTestSalonMember>>;

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
    { timeout: 30_000 },
  );
  await page.locator('input[inputmode="email"]').fill(owner.email);
  await page.locator('input[type="password"]').fill(owner.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
}

/** ISO for a booking that started `min` minutes before real now (+ a 45m span). */
function lateStart(min: number): { startIso: string; endIso: string } {
  const start = Date.now() - min * 60_000;
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(start + 45 * 60_000).toISOString(),
  };
}

/**
 * The live board only loads the salon's current calendar day. During the
 * first `min` minutes after UTC midnight, a booking that is genuinely `min`
 * minutes late belongs to yesterday and therefore cannot appear on today's
 * board. Skip only that mathematically impossible boundary window; the tier
 * calculation itself is covered by scripts/test-lateness.ts.
 */
function skipIfLatenessCrossesUtcDay(min: number): void {
  const now = new Date();
  const utcDayStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  test.skip(
    now.getTime() - utcDayStart < min * 60_000,
    `Cannot render a ${min}-minute-late booking on today's UTC board yet`,
  );
}

/** Seed a confirmed booking `min` minutes late on the free staff column. */
async function seedLate(
  min: number,
  status: "confirmed" | "completed" = "confirmed",
) {
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
  const v = (data as { noshow_charge_status?: string | null } | null)
    ?.noshow_charge_status;
  return v ?? null;
}

async function readNoShowCandidate(bookingId: string): Promise<{
  status: string | null;
  candidateAt: string | null;
}> {
  const { data, error } = await supabaseAdmin
    .from("bookings")
    .select("status, no_show_candidate_at")
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw new Error(`readNoShowCandidate: ${error.message}`);
  const row = data as {
    status?: string | null;
    no_show_candidate_at?: string | null;
  } | null;
  return {
    status: row?.status ?? null,
    candidateAt: row?.no_show_candidate_at ?? null,
  };
}

/**
 * A freshly seeded booking can briefly be absent from the server-rendered grid
 * while Supabase's pooled/PostgREST reads catch up with the write.  Re-load the
 * complete server component a few times instead of treating that short
 * visibility window as a product regression.  The bounded poll still fails on
 * a genuinely missing booking and keeps the assertion tied to the exact row.
 */
async function expectServerRenderedItem(
  page: Page,
  testId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await page.getByTestId(testId).count()) > 0) return true;

        await page.reload({ waitUntil: "domcontentloaded" });
        await page
          .getByTestId("receptionist-center-loaded")
          .first()
          .waitFor({ state: "attached", timeout: 20_000 });
        return (await page.getByTestId(testId).count()) > 0;
      },
      { timeout: 30_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe(true);
}

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
  owner = await seedTestSalonMember(fx.salonId, "owner");
});

test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});

test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
  await cleanupTestUser(owner.userId);
});

test.describe("DRC lateness escalation", () => {
  test("due tier (≤10m late): ring only, no clock icon, Start button shown", async ({
    page,
  }) => {
    skipIfLatenessCrossesUtcDay(3);
    const id = await seedLate(3);
    await gotoReceptionistCenter(page, fx.slug);

    await expectServerRenderedItem(page, `booking-block-lateness-${id}`);
    // due stays calm — no clock marker in the icon stack.
    await expect(page.getByTestId(`booking-block-icon-late-${id}`)).toHaveCount(
      0,
    );
    // owner (demo cookie) can change status → inline Start is offered.
    await expect(page.getByTestId(`booking-block-start-${id}`)).toBeAttached();
  });

  test("late tier (10–20m): ring + amber clock icon", async ({ page }) => {
    skipIfLatenessCrossesUtcDay(13);
    const id = await seedLate(13);
    await gotoReceptionistCenter(page, fx.slug);

    await expectServerRenderedItem(page, `booking-block-lateness-${id}`);
    await expect(
      page.getByTestId(`booking-block-icon-late-${id}`),
    ).toBeAttached();
  });

  test("critical tier (≥20m): ring + clock icon", async ({ page }) => {
    skipIfLatenessCrossesUtcDay(23);
    const id = await seedLate(23);
    await gotoReceptionistCenter(page, fx.slug);

    await expectServerRenderedItem(page, `booking-block-lateness-${id}`);
    await expect(
      page.getByTestId(`booking-block-icon-late-${id}`),
    ).toBeAttached();
  });

  test("scheduler flags a review candidate without changing attendance status", async ({
    page,
  }) => {
    skipIfLatenessCrossesUtcDay(23);
    const id = await seedLate(23);

    const { error: settingError } = await supabaseAdmin
      .from("salons")
      .update({ auto_no_show_minutes: 15 } as never)
      .eq("id", fx.salonId);
    if (settingError)
      throw new Error(`enable candidate review: ${settingError.message}`);

    try {
      const { error: runError } = await supabaseAdmin.rpc(
        "auto_mark_no_shows" as never,
      );
      if (runError) throw new Error(`auto_mark_no_shows: ${runError.message}`);

      await expect
        .poll(
          async () => {
            const row = await readNoShowCandidate(id);
            return row.status === "confirmed" && row.candidateAt !== null;
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      const first = await readNoShowCandidate(id);
      expect(first.candidateAt).not.toBeNull();

      // Idempotency: the persisted first-detected timestamp never changes.
      const { error: rerunError } = await supabaseAdmin.rpc(
        "auto_mark_no_shows" as never,
      );
      if (rerunError)
        throw new Error(`auto_mark_no_shows rerun: ${rerunError.message}`);
      await expect(readNoShowCandidate(id)).resolves.toEqual(first);

      await gotoReceptionistCenter(page, fx.slug);
      await expectServerRenderedItem(
        page,
        `booking-block-no-show-candidate-${id}`,
      );
      expect((await getBookingRow(fx.salonId, id))?.status).toBe("confirmed");
    } finally {
      const { error: restoreError } = await supabaseAdmin
        .from("salons")
        .update({ auto_no_show_minutes: null } as never)
        .eq("id", fx.salonId);
      if (restoreError)
        throw new Error(`restore candidate review: ${restoreError.message}`);
    }
  });

  test("completed booking past start shows NO lateness escalation", async ({
    page,
  }) => {
    skipIfLatenessCrossesUtcDay(13);
    const id = await seedLate(13, "completed");
    await gotoReceptionistCenter(page, fx.slug);

    await expectServerRenderedItem(page, `booking-block-${id}`);
    await expect(page.getByTestId(`booking-block-lateness-${id}`)).toHaveCount(
      0,
    );
    await expect(page.getByTestId(`booking-block-start-${id}`)).toHaveCount(0);
  });

  test("inline Start flips confirmed → in_progress and clears the escalation", async ({
    page,
  }) => {
    skipIfLatenessCrossesUtcDay(13);
    const id = await seedLate(13);
    await gotoReceptionistCenter(page, fx.slug);

    await expectServerRenderedItem(page, `booking-block-start-${id}`);
    const startBtn = page.getByTestId(`booking-block-start-${id}`);
    await startBtn.evaluate((el: HTMLElement) => el.click());

    await expect
      .poll(async () => (await getBookingRow(fx.salonId, id))?.status, {
        timeout: 15_000,
      })
      .toBe("in_progress");
    // Escalation ring is gone once the service has started.
    await expect(page.getByTestId(`booking-block-lateness-${id}`)).toHaveCount(
      0,
    );
  });
});

test.describe("DRC no-show tombstone + fee decision", () => {
  async function seedNoShow(opts: { withCard: boolean }) {
    // Keep the row inside the fixture's UTC calendar day. Subtracting a fixed
    // 30 minutes from real "now" crosses into yesterday during the first half
    // hour after midnight, while the receptionist page correctly loads today;
    // the seeded no-show then cannot appear no matter how often the page reloads.
    const dayStartMs = Date.parse(isoAtUtcYmdHourMinute(fx.ymdUtc, 0, 0));
    const dayEndMs = dayStartMs + 24 * 60 * 60_000;
    const startMs = Math.min(
      dayEndMs - 45 * 60_000,
      Math.max(dayStartMs, Date.now() - 30 * 60_000),
    );
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(startMs + 45 * 60_000).toISOString();
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
    const { data, error } = await supabaseAdmin.rpc(
      "transition_booking_to_terminal" as never,
      {
        p_booking_id: id,
        p_salon_id: fx.salonId,
        p_actor_user_id: owner.userId,
        p_actor_role: "owner",
        p_reason: "desk_no_show",
      } as never,
    );
    const transition = (Array.isArray(data) ? data[0] : data) as {
      success?: boolean;
      code?: string;
    } | null;
    if (error || !transition?.success) {
      throw new Error(
        `seedNoShow: ${error?.message ?? transition?.code ?? "unknown"}`,
      );
    }

    // Do not navigate until the status write is observable. CI's local
    // PostgREST pool can briefly return before a follow-up server-rendered
    // read sees the update, which made this fixture intermittently look like
    // an active booking instead of a no-show tombstone.
    await expect
      .poll(async () => (await getBookingRow(fx.salonId, id))?.status, {
        timeout: 15_000,
        intervals: [250, 500, 1_000],
      })
      .toBe("no_show");
    return id;
  }

  test("no-show renders a read-only tombstone without an Undo action", async ({
    page,
  }) => {
    const id = await seedNoShow({ withCard: false });
    await loginAsOwner(page);
    await gotoReceptionistCenter(page, fx.slug);

    await expectServerRenderedItem(page, `noshow-tombstone-${id}`);
    const tomb = page.getByTestId(`noshow-tombstone-${id}`);
    await tomb.evaluate((el: HTMLElement) => el.click());
    await expect(
      page.getByRole("button", { name: /undo no-show/i }),
    ).toHaveCount(0);
  });

  test("tombstone Waive sets the fee to 'waived' (no charge)", async ({
    page,
  }) => {
    const id = await seedNoShow({ withCard: true });
    await loginAsOwner(page);
    await gotoReceptionistCenter(page, fx.slug);

    await expectServerRenderedItem(page, `noshow-tombstone-${id}`);
    const tomb = page.getByTestId(`noshow-tombstone-${id}`);
    await tomb.evaluate((el: HTMLElement) => el.click());

    const waive = page.getByRole("button", { name: /waive fee/i });
    await expect(waive).toBeVisible();
    // This test verifies the server mutation, not popover positioning. A late
    // tombstone can sit beneath the fixed desktop sidebar after the timeline
    // auto-scrolls to "now", so Playwright's pointer-actionability check sees
    // the sidebar intercepting the click even though the popover/button is
    // rendered. Use the same synthetic click convention as the drawer test
    // below and the tombstone opener above.
    await waive.evaluate((el: HTMLElement) => el.click());

    await expect
      .poll(() => readChargeStatus(id), { timeout: 15_000 })
      .toBe("waived");
  });

  test("marking no-show with a card on file opens the Charge/Waive modal (not an instant mark)", async ({
    page,
  }) => {
    skipIfLatenessCrossesUtcDay(13);
    const id = await seedLate(13);
    await attachCard(id);
    await loginAsOwner(page);
    await gotoReceptionistCenter(page, fx.slug);

    await page
      .getByTestId(`booking-block-${id}`)
      .evaluate((el: HTMLElement) => el.click());
    await expect(page.getByTestId("booking-detail-drawer")).toBeVisible();

    // Drawer "No-show" action → fee modal intercepts before marking.
    // evaluate-click (not .click()) — the drawer-footer button fails Playwright's
    // visible/enabled/stable actionability gate under the open animation (the
    // repo's helpers use the same synthetic-click trick for drawer/sidebar UI).
    await page
      .getByTestId("drawer-no-show")
      .evaluate((el: HTMLElement) => el.click());

    // The modal title is unique ("No-show fee"); avoid getByRole("dialog")
    // since the drawer is also a dialog.
    await expect(page.getByText(/^no-show fee$/i)).toBeVisible();
    // Still confirmed — the modal gates the decision, nothing marked yet.
    expect((await getBookingRow(fx.salonId, id))?.status).toBe("confirmed");

    // Choose Waive → booking becomes no_show + fee 'waived'.
    await page
      .getByRole("button", { name: /^waive fee$/i })
      .evaluate((el: HTMLElement) => el.click());
    await expect
      .poll(async () => (await getBookingRow(fx.salonId, id))?.status, {
        timeout: 15_000,
      })
      .toBe("no_show");
    await expect
      .poll(() => readChargeStatus(id), { timeout: 15_000 })
      .toBe("waived");
  });
});
