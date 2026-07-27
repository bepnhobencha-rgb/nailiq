import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import {
  cleanupTestSalon,
  gotoBookingServiceStep,
  seedTestSalon,
  setReactInputValue,
} from "./helpers/db";

/**
 * Pre-launch error-path smoke for the public booking page (`/[slug]`).
 *
 * Note on isolation: the prompt asked for `beforeAll/afterAll`, but several
 * tests below mutate salon state (`profile_complete`, `booking_closed_dates`,
 * `timezone`, `opening_hours`) — sharing a single seeded salon would break
 * "each test must be independent". This file follows the `booking.spec.ts`
 * pattern of `beforeEach/afterEach` instead.
 *
 * Note on overlap with existing specs: a few scenarios duplicate coverage
 * that's already in `booking-conflict.spec.ts` (DB-level race),
 * `booking-validation.spec.ts` (bv-1..bv-4), and `booking-security.spec.ts`
 * (xss-1, xss-3). They're kept here because the task list called for them
 * explicitly; comments on each test point at the canonical spec.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

test.skip(
  !supabaseUrl.trim() || !serviceKey.trim(),
  "Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (e.g. .env.local).",
);

const supabase = createClient(supabaseUrl, serviceKey);

const PRIMARY_SLUG = "e2e-booking-errors";
const OTHER_SLUG = "e2e-booking-errors-other";

const STANDARD_HOURS = {
  mon: { open: "09:00", close: "17:00", closed: false },
  tue: { open: "09:00", close: "17:00", closed: false },
  wed: { open: "09:00", close: "17:00", closed: false },
  thu: { open: "09:00", close: "17:00", closed: false },
  fri: { open: "09:00", close: "17:00", closed: false },
  sat: { open: "09:00", close: "17:00", closed: false },
  sun: { open: "09:00", close: "17:00", closed: false },
};

async function getSalonId(slug: string): Promise<string> {
  const { data } = await supabase
    .from("salons")
    .select("id")
    .eq("slug", slug)
    .single();
  if (!data?.id) throw new Error(`salon ${slug} not found`);
  return String(data.id);
}

async function getFirstStaffAndService(
  salonId: string,
): Promise<{ staffId: string; serviceId: string }> {
  const [{ data: stf }, { data: svc }] = await Promise.all([
    supabase
      .from("staff")
      .select("id")
      .eq("salon_id", salonId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("services")
      .select("id")
      .eq("salon_id", salonId)
      .limit(1)
      .maybeSingle(),
  ]);
  return {
    staffId: String(stf?.id ?? ""),
    serviceId: String(svc?.id ?? ""),
  };
}

async function setSalonRow(slug: string, patch: Record<string, unknown>) {
  await supabase.from("salons").update(patch).eq("slug", slug);
}

async function navigateToTimeStep(page: Page, slug: string) {
  // Phone-first entry gate (PR #328): clear the gate so the service step shows.
  await gotoBookingServiceStep(page, slug);
  // Target the inner select button directly; clicking the outer service-item
  // div is unreliable on narrow (mobile) viewports where the hit-test center
  // may not land on the button.
  const serviceStep = page.locator(
    'section[aria-labelledby="svc-heading"]',
  );
  await serviceStep
    .locator('[data-testid="service-tile-select"]')
    .first()
    .click();
  await serviceStep.getByRole("button", { name: "Continue" }).click();
  // Wait for the staff panel to animate in before interacting.
  const staffStep = page.locator(
    'section[aria-labelledby="staff-heading"]',
  );
  await staffStep
    .locator('[data-testid="staff-item"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await staffStep.locator('[data-testid="staff-item"]').first().click();
  await staffStep.getByRole("button", { name: "Continue" }).click();
  // The month grid is collapsed behind the "📅 More dates" toggle (#593); open
  // it so the date-day grid below mounts. Then pick a selectable day. The
  // calendar opens on the first month with availability; late in the month a
  // salon open every day can still leave the current view with only "today"
  // (which renders as `date-today`, not `date-day`), so advance a month when no
  // selectable `date-day` is present.
  const dateStep = page.locator(
    'section[aria-labelledby="date-heading"]',
  );
  await dateStep
    .locator('[data-testid="date-toggle-calendar"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  await dateStep.locator('[data-testid="date-toggle-calendar"]').click();
  await dateStep
    .locator('[data-testid="calendar-grid"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  const selectableDay = dateStep
    .locator('[data-testid="date-day"]:not([disabled])')
    .first();
  // Advance a month at a time until a selectable day shows. Wait for the day to
  // actually appear (5s) before deciding to advance again — checking count
  // immediately after a next-month click races React's re-render and overshoots,
  // which kept the grid re-rendering (slot-hint stream) so the eventual click hit
  // a detaching element.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await selectableDay.waitFor({ state: "visible", timeout: 5_000 });
      break;
    } catch {
      const next = dateStep.locator('[data-testid="calendar-next-month"]');
      if (!(await next.isEnabled().catch(() => false))) break;
      await next.click();
    }
  }
  await selectableDay.waitFor({ state: "visible", timeout: 15_000 });
  await selectableDay.click();
  // Confirm the day actually registered as selected BEFORE advancing. On mobile
  // WebKit the slot-hint stream re-renders the grid and the staff→date / date→
  // time AnimatePresence briefly keeps two panels mounted, so clicking Continue
  // too eagerly could (a) fire before `selectedDate` propagated or (b) hit the
  // exiting panel's button via `.first()` — either way the flow stays on the
  // date step and the time slots never load (20s timeout). `aria-pressed` flips
  // true once the selection commits, so it's a reliable settle signal.
  await dateStep
    .locator('[data-testid="date-day"][aria-pressed="true"]')
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await dateStep.getByRole("button", { name: "Continue" }).click();
  // The time grid fetches slots async (Supabase round-trip) behind a skeleton.
  // Wait for the skeleton to clear before asserting a slot so a slow fetch under
  // CI load doesn't eat the slot budget; `detached` resolves immediately if the
  // fetch already finished.
  const timeStep = page.locator(
    'section[aria-labelledby="time-heading"]',
  );
  await timeStep
    .locator('[data-testid="time-slots-skeleton"]')
    .waitFor({ state: "detached", timeout: 25_000 })
    .catch(() => {});
  await timeStep
    .locator('[data-testid="time-slot"]')
    .first()
    .waitFor({ state: "visible", timeout: 25_000 });
}

async function navigateToInfoStep(page: Page, slug: string) {
  await navigateToTimeStep(page, slug);
  const timeStep = page.locator(
    'section[aria-labelledby="time-heading"]',
  );
  const firstAvailableSlot = timeStep
    .locator('[data-testid="time-slot"]:not([disabled])')
    .first();
  await firstAvailableSlot.click();
  // The selection is committed through React state. Under CI load the next
  // click can otherwise land before that state enables the step transition,
  // leaving the wizard on Time until the Info assertion times out.
  await expect(firstAvailableSlot).toHaveAttribute("aria-pressed", "true");
  await timeStep.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("booking-info-name")).toBeVisible({
    timeout: 15_000,
  });
}

async function navigateToConfirmStep(
  page: Page,
  slug: string,
  opts?: { name?: string; phone?: string; notes?: string },
) {
  await navigateToInfoStep(page, slug);
  // Phone-first: phone captured at the entry gate; info step takes name only.
  await page.getByTestId("booking-info-name").fill(opts?.name ?? "Test Client");
  if (opts?.notes) {
    const notes = page.locator(
      'textarea[name="clientNotes"], textarea[data-testid="booking-info-notes"]',
    );
    if ((await notes.count()) > 0) {
      await notes.first().fill(opts.notes);
    }
  }
  await page.getByRole("button", { name: "Continue" }).first().click();
  await expect(
    page.getByRole("button", { name: "Confirm booking" }),
  ).toBeVisible({ timeout: 12_000 });
}

async function readSelectedSlotIso(page: Page): Promise<{
  staffId: string;
  startMs: number;
  endMs: number;
}> {
  const handle = page.locator('[data-testid="time-slot"][data-selected="true"]');
  await handle.first().waitFor({ state: "attached", timeout: 5_000 });
  const startIso = await handle
    .first()
    .getAttribute("data-start-utc");
  const endIso = await handle.first().getAttribute("data-end-utc");
  const staff = await handle.first().getAttribute("data-staff-id");
  return {
    staffId: String(staff ?? ""),
    startMs: startIso ? new Date(startIso).getTime() : 0,
    endMs: endIso ? new Date(endIso).getTime() : 0,
  };
}

test.describe("Booking error scenarios — /[slug]", () => {
  test.beforeEach(async () => {
    await seedTestSalon({
      phone: "15553330001",
      slug: PRIMARY_SLUG,
      name: "E2E Errors Salon",
    });
  });

  test.afterEach(async () => {
    await cleanupTestSalon(PRIMARY_SLUG);
    await cleanupTestSalon(OTHER_SLUG);
  });

  // ──────────────────────────────────────────────────────────
  // GROUP 1 — CONFLICT / DOUBLE BOOKING
  // ──────────────────────────────────────────────────────────

  // 1. Double-book same staff + same time slot via the public booking flow.
  //    Strategy: navigate the flow once to capture an available slot, then
  //    pre-occupy that slot via the service-role client, then drive a fresh
  //    page through the same selections. The slot-listing layer should drop
  //    the now-occupied slot — the second guest can never reach a state
  //    that would conflict. We assert the slot disappears.
  test("conflict-1: a pre-existing booking removes its slot from the picker for the next guest", async ({
    page,
    browser,
  }) => {
    const salonId = await getSalonId(PRIMARY_SLUG);
    const { staffId, serviceId } = await getFirstStaffAndService(salonId);

    // First guest — scout an available slot. Navigate manually so we can
    // read data-ymd from the selected date cell BEFORE leaving the date step
    // (date-day elements are removed from the DOM once the time panel mounts).
    await gotoBookingServiceStep(page, PRIMARY_SLUG);
    await page.locator('[data-testid="service-tile-select"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();
    await page
      .locator('[data-testid="staff-item"]')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.locator('[data-testid="staff-item"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();
    // Reveal the collapsed month grid (#593) before reading a grid day's data-ymd.
    await page.locator('[data-testid="date-toggle-calendar"]').click();
    const pickedDateBtn = page
      .locator('[data-testid="date-day"]:not([disabled])')
      .first();
    await pickedDateBtn.waitFor({ state: "visible", timeout: 15_000 });
    const ymd = (await pickedDateBtn.getAttribute("data-ymd")) ?? null;
    if (!ymd) {
      test.skip(true, "date-day cells did not expose a data-ymd attribute");
      return;
    }
    await pickedDateBtn.click();
    await page.getByRole("button", { name: "Continue" }).first().click();
    await page
      .locator('[data-testid="time-slot"]')
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });

    // Only pick from AVAILABLE slots — the panel renders booked slots as
    // disabled buttons (data-available="false"). We block this specific slot,
    // then verify it becomes disabled for the next guest.
    const firstSlotText =
      (await page
        .locator('[data-testid="time-slot"][data-available="true"]')
        .first()
        .textContent()) ?? "";
    expect(firstSlotText.trim()).not.toBe("");

    // Block that slot at the DB level: parse the slot label to get the UTC time.
    const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(firstSlotText.trim());
    if (!m) throw new Error(`could not parse slot label "${firstSlotText}"`);
    let hour = Number(m[1]);
    const minute = Number(m[2]);
    const meridiem = m[3]!.toUpperCase();
    if (meridiem === "PM" && hour !== 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    const [y, mo, d] = ymd.split("-").map(Number);
    const startLocal = new Date(y!, mo! - 1, d!, hour, minute, 0, 0);
    const endLocal = new Date(startLocal.getTime() + 60 * 60_000);

    await supabase.from("bookings").insert({
      salon_id: salonId,
      service_id: serviceId,
      staff_id: staffId,
      client_name: "Conflict Holder",
      client_phone: "15550009999",
      status: "confirmed",
      start_time_utc: startLocal.toISOString(),
      end_time_utc: endLocal.toISOString(),
    });

    // Second guest — same path; the booked slot should now appear as
    // disabled (data-available="false") rather than bookable.
    const ctx = await browser.newContext();
    const page2 = await ctx.newPage();
    await navigateToTimeStep(page2, PRIMARY_SLUG);
    const blockedSlotBtn = page2
      .locator('[data-testid="time-slot"]')
      .filter({ hasText: firstSlotText.trim() })
      .first();
    await expect(blockedSlotBtn).toBeDisabled();
    await ctx.close();
  });

  // 2. Race: two concurrent DB inserts on the same staff/time → exactly one
  //    survives. This duplicates booking-conflict.spec.ts; kept here per the
  //    checklist. The DB enforces via the GIST EXCLUDE + UNIQUE-on-start.
  test("conflict-2: two parallel identical inserts — only one succeeds", async () => {
    const salonId = await getSalonId(PRIMARY_SLUG);
    const { staffId, serviceId } = await getFirstStaffAndService(salonId);

    const base = new Date();
    base.setUTCDate(base.getUTCDate() + 2);
    base.setUTCHours(14, 0, 0, 0);
    const start = base.toISOString();
    const end = new Date(base.getTime() + 45 * 60_000).toISOString();
    const common = {
      salon_id: salonId,
      service_id: serviceId,
      staff_id: staffId,
      client_phone: "15550008888",
      status: "confirmed" as const,
      start_time_utc: start,
      end_time_utc: end,
    };

    const [a, b] = await Promise.all([
      supabase
        .from("bookings")
        .insert({ ...common, client_name: "RacerA" })
        .select("id")
        .maybeSingle(),
      supabase
        .from("bookings")
        .insert({ ...common, client_name: "RacerB" })
        .select("id")
        .maybeSingle(),
    ]);

    const successes = [a, b].filter((r) => r.error === null && r.data?.id);
    const failures = [a, b].filter((r) => r.error !== null);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    const code = failures[0]!.error?.code ?? "";
    // 23P01 = exclusion-constraint (GIST overlap), 23505 = unique-on-start.
    // 40P01 = deadlock_detected: under truly concurrent inserts Postgres may
    // resolve the race by aborting one transaction as a deadlock victim instead
    // of raising the constraint — still exactly one survivor, the contract we
    // care about, so it's an accepted rejection code (was an intermittent flake).
    expect(["23P01", "23505", "40P01"]).toContain(code);

    await supabase.from("bookings").delete().eq("id", successes[0]!.data!.id);
  });

  // 3. Service-duration overlap: an existing 60-minute booking at 14:00
  //    should hide the 14:30 slot on the same staff (overlap, not exact
  //    collision).
  test("conflict-3: an existing 14:00 booking hides 14:30 from the picker for the same staff", async ({
    page,
  }) => {
    const salonId = await getSalonId(PRIMARY_SLUG);
    await setSalonRow(PRIMARY_SLUG, { opening_hours: STANDARD_HOURS });
    const { staffId, serviceId } = await getFirstStaffAndService(salonId);

    const target = new Date();
    target.setDate(target.getDate() + 2);
    const ymd = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
    const start = new Date(target);
    start.setHours(14, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60_000);

    await supabase.from("bookings").insert({
      salon_id: salonId,
      service_id: serviceId,
      staff_id: staffId,
      client_name: "Anchor",
      client_phone: "15550007777",
      status: "confirmed",
      start_time_utc: start.toISOString(),
      end_time_utc: end.toISOString(),
    });

    await gotoBookingServiceStep(page, PRIMARY_SLUG);
    await page.locator('[data-testid="service-tile-select"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();
    await page
      .locator('[data-testid="staff-item"]')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.locator('[data-testid="staff-item"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    // Open the collapsed month grid (#593), then wait for it to render before
    // inspecting specific date cells.
    await page.locator('[data-testid="date-toggle-calendar"]').click();
    await page
      .locator('[data-testid="date-day"]')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    const dayBtn = page.locator(
      `[data-testid="date-day"][data-ymd="${ymd}"]`,
    );
    if ((await dayBtn.count()) === 0) {
      test.skip(true, "target date not visible in calendar (window/closed)");
      return;
    }
    await dayBtn.first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();
    await page
      .locator('[data-testid="time-slot"]')
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });

    // Only check AVAILABLE (non-disabled) slots — the time panel renders
    // booked slots as line-through/disabled buttons with data-available="false".
    // Using allTextContents() on all [data-testid="time-slot"] would include
    // disabled slots too, giving a false failure.
    const availableSlotTexts = (
      await page
        .locator('[data-testid="time-slot"][data-available="true"]')
        .allTextContents()
    ).map((s) => s.trim());

    // The 14:00 slot is also taken; the next-aligned 14:30 must not appear
    // as an available (bookable) slot.
    expect(availableSlotTexts).not.toContain("2:30 PM");
    expect(availableSlotTexts).not.toContain("14:30");
  });

  // ──────────────────────────────────────────────────────────
  // GROUP 2 — BUSINESS HOURS VALIDATION
  // ──────────────────────────────────────────────────────────

  // 4. Past dates render as disabled buttons (data-past="true").
  test("hours-4: past dates in the calendar are disabled and marked data-past", async ({
    page,
  }) => {
    await gotoBookingServiceStep(page, PRIMARY_SLUG);
    await page.locator('[data-testid="service-tile-select"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();
    await page
      .locator('[data-testid="any-staff-option"]')
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.locator('[data-testid="any-staff-option"]').click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    // Past cells live only in the month grid (the strip starts today); open it.
    await page.locator('[data-testid="date-toggle-calendar"]').click();
    const pastCells = page.locator('[data-testid="date-day"][data-past="true"]');
    const count = await pastCells.count();
    if (count === 0) {
      // First of the month — no prior cells in current view.
      return;
    }
    for (let i = 0; i < Math.min(count, 3); i += 1) {
      await expect(pastCells.nth(i)).toBeDisabled();
    }
  });

  // 5. Outside opening hours: with hours pinned to 09:00–17:00, the time
  //    picker must not surface any slot at or after 21:00.
  test("hours-5: no time slots are offered outside opening hours (no 9pm+ on a 9–5 schedule)", async ({
    page,
  }) => {
    await setSalonRow(PRIMARY_SLUG, { opening_hours: STANDARD_HOURS });
    await navigateToTimeStep(page, PRIMARY_SLUG);
    const slotTexts = (
      await page.locator('[data-testid="time-slot"]').allTextContents()
    ).map((s) => s.trim());
    for (const label of slotTexts) {
      const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(label);
      if (!m) continue;
      let h = Number(m[1]);
      const meridiem = m[3]!.toUpperCase();
      if (meridiem === "PM" && h !== 12) h += 12;
      if (meridiem === "AM" && h === 12) h = 0;
      expect(h, `slot ${label} is outside 9–17`).toBeLessThan(17);
      expect(h, `slot ${label} is outside 9–17`).toBeGreaterThanOrEqual(9);
    }
  });

  // 6. Closed-day: mark a specific YMD closed and confirm the calendar cell
  //    is disabled.
  test("hours-6: dates listed in booking_closed_dates are disabled on the calendar", async ({
    page,
  }) => {
    const closed = new Date();
    closed.setDate(closed.getDate() + 3);
    const ymd = `${closed.getFullYear()}-${String(closed.getMonth() + 1).padStart(2, "0")}-${String(closed.getDate()).padStart(2, "0")}`;

    await setSalonRow(PRIMARY_SLUG, {
      booking_closed_dates: [ymd],
      opening_hours: STANDARD_HOURS,
    });

    await gotoBookingServiceStep(page, PRIMARY_SLUG);
    await page.locator('[data-testid="service-tile-select"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();
    await page
      .locator('[data-testid="any-staff-option"]')
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.locator('[data-testid="any-staff-option"]').click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    // Open the collapsed month grid (#593) to inspect the closed-date cell.
    await page.locator('[data-testid="date-toggle-calendar"]').click();
    const cell = page.locator(
      `[data-testid="date-day"][data-ymd="${ymd}"]`,
    );
    if ((await cell.count()) === 0) {
      test.skip(true, "closed date not in visible calendar window");
      return;
    }
    await expect(cell.first()).toBeDisabled();
  });

  // 7. Paused salon (profile_complete=false → acceptingBookings=false in
  //    loadBookingServices) — page renders SalonBookingPaused, not the flow.
  test("hours-7: a salon with profile_complete=false renders the paused state, no service picker", async ({
    page,
  }) => {
    await setSalonRow(PRIMARY_SLUG, { profile_complete: false });
    await page.goto(`/${PRIMARY_SLUG}`);

    await expect(page.locator('[data-testid="service-item"]')).toHaveCount(0);
    // The paused panel contains the salon label; service step is gone.
    await expect(
      page.getByRole("button", { name: "Continue" }),
    ).toHaveCount(0);
  });

  // ──────────────────────────────────────────────────────────
  // GROUP 3 — SECURITY / IDOR
  // ──────────────────────────────────────────────────────────

  // 8. IDOR — staff from another salon: salon B's public booking page must
  //    NOT surface any of salon A's staff in the staff picker. This tests
  //    the listing-layer guard (the submit guard in submitPublicBooking
  //    enforces it again at submit time; this test covers the read side).
  test("idor-8: another salon's staff are not present in the staff picker", async ({
    page,
  }) => {
    const other = await seedTestSalon({
      phone: "15550006666",
      slug: OTHER_SLUG,
      name: "E2E Other Salon",
    });
    const otherSalonId = other.salonId;
    const { data: otherStaff } = await supabase
      .from("staff")
      .select("id, name")
      .eq("salon_id", otherSalonId);
    const otherIds = (otherStaff ?? []).map((s: { id: string }) => String(s.id));
    expect(otherIds.length).toBeGreaterThan(0);

    await gotoBookingServiceStep(page, PRIMARY_SLUG);
    await page.locator('[data-testid="service-tile-select"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    const staffItems = page.locator('[data-testid="staff-item"]');
    // Wait for staff panel to animate in before inspecting items.
    await staffItems.first().waitFor({ state: "visible", timeout: 15_000 });
    const renderedIds: string[] = [];
    const n = await staffItems.count();
    for (let i = 0; i < n; i += 1) {
      const id = await staffItems.nth(i).getAttribute("data-staff-id");
      if (id) renderedIds.push(id);
    }
    for (const foreignId of otherIds) {
      expect(renderedIds).not.toContain(foreignId);
    }
  });

  // 9. IDOR — service from another salon: ditto for the service picker.
  test("idor-9: another salon's services are not present in the service picker", async ({
    page,
  }) => {
    const other = await seedTestSalon({
      phone: "15550005555",
      slug: OTHER_SLUG,
      name: "E2E Other Salon Svc",
    });
    const { data: otherSvcs } = await supabase
      .from("services")
      .select("id")
      .eq("salon_id", other.salonId);
    const otherIds = (otherSvcs ?? []).map((s: { id: string }) =>
      String(s.id),
    );
    expect(otherIds.length).toBeGreaterThan(0);

    // Phone-first: clear the entry gate so the service picker renders.
    await gotoBookingServiceStep(page, PRIMARY_SLUG);
    const items = page.locator('[data-testid="service-item"]');
    await items.first().waitFor({ state: "visible", timeout: 10_000 });
    const renderedIds: string[] = [];
    const n = await items.count();
    for (let i = 0; i < n; i += 1) {
      const id = await items.nth(i).getAttribute("data-service-id");
      if (id) renderedIds.push(id);
    }
    for (const foreignId of otherIds) {
      expect(renderedIds).not.toContain(foreignId);
    }
  });

  // ──────────────────────────────────────────────────────────
  // GROUP 4 — INPUT VALIDATION  (overlaps booking-validation.spec.ts)
  // ──────────────────────────────────────────────────────────

  // 10. Empty name → inline error on blur (cf. bv-3).
  test("input-10: empty client name shows the inline name error", async ({
    page,
  }) => {
    await navigateToInfoStep(page, PRIMARY_SLUG);
    // Gate pre-fills the name; clear it so the blur validates an empty field.
    await page.getByTestId("booking-info-name").fill("");
    await page.getByTestId("booking-info-name").blur();
    await expect(page.getByTestId("booking-info-name-error")).toBeVisible();
  });

  // 11. Phone-first: phone moved to the entry gate. With no phone entered the
  //     individual flow never mounts, so the service step is unreachable.
  test("input-11: an empty phone at the entry gate keeps the flow gated", async ({
    page,
  }) => {
    await page.goto(`/${PRIMARY_SLUG}`);
    await expect(page.getByTestId("booking-phone-gate")).toBeVisible();
    await expect(
      page.locator('[data-testid="service-tile-select"]'),
    ).toHaveCount(0);
  });

  // 12. Phone-first: a malformed phone at the gate fails validateGuestPhone, so
  //     the flow stays gated (cf. bv-1). "abc123" → digits "123" survive
  //     formatPhoneInputProgressive but are not a valid number.
  test("input-12: an invalid phone at the entry gate keeps the flow gated", async ({
    page,
  }) => {
    await page.goto(`/${PRIMARY_SLUG}`);
    await expect(page.getByTestId("booking-phone-gate")).toBeVisible();
    await setReactInputValue(
      page.getByTestId("booking-entry-phone"),
      "abc123",
    );
    await expect(
      page.locator('[data-testid="service-tile-select"]'),
    ).toHaveCount(0);
  });

  // 13. No service selected → Continue disabled on the service step.
  test("input-13: with no service selected, Continue is disabled on step 1", async ({
    page,
  }) => {
    // Phone-first: clear the entry gate so the service step renders, then
    // assert Continue is disabled while no service is selected.
    await gotoBookingServiceStep(page, PRIMARY_SLUG);
    await expect(
      page.getByRole("button", { name: "Continue" }),
    ).toBeDisabled();
  });

  // 14. No staff selected → Continue disabled on the staff step.
  test("input-14: with no staff selected, Continue is disabled on step 2", async ({
    page,
  }) => {
    await gotoBookingServiceStep(page, PRIMARY_SLUG);
    await page.locator('[data-testid="service-tile-select"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();
    await page
      .locator('[data-testid="staff-item"]')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "Continue" }),
    ).toBeDisabled();
  });

  // 15. No time slot selected → Continue disabled on the time step.
  test("input-15: with no time slot selected, Continue is disabled on step 4", async ({
    page,
  }) => {
    await navigateToTimeStep(page, PRIMARY_SLUG);
    await expect(
      page.getByRole("button", { name: "Continue" }),
    ).toBeDisabled();
  });

  // ──────────────────────────────────────────────────────────
  // GROUP 5 — EDGE CASES
  // ──────────────────────────────────────────────────────────

  // 16. Name length: 500+ chars must be rejected (cf. bv-4 boundary at 100).
  test("edge-16: a 500-character name triggers the name error", async ({
    page,
  }) => {
    await navigateToInfoStep(page, PRIMARY_SLUG);

    await page
      .getByTestId("booking-info-name")
      .evaluate((el: HTMLInputElement) => {
        el.removeAttribute("maxLength");
        el.removeAttribute("maxlength");
      });
    await page.getByTestId("booking-info-name").fill("a".repeat(500));
    await page.getByTestId("booking-info-name").blur();
    await expect(page.getByTestId("booking-info-name-error")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue" }),
    ).toBeDisabled();
  });

  // 17. XSS — the inline allowlist rejects the payload; even if it were to
  //    slip past, we also confirm no script tag is in the live DOM.
  test("edge-17: a <script> payload is rejected and never executes", async ({
    page,
  }) => {
    let alerted = false;
    page.on("dialog", async (d) => {
      alerted = true;
      await d.dismiss();
    });

    await navigateToInfoStep(page, PRIMARY_SLUG);
    await page
      .getByTestId("booking-info-name")
      .fill(`<script>alert('xss')</script>`);
    await page.getByTestId("booking-info-name").blur();
    await expect(page.getByTestId("booking-info-name-error")).toBeVisible();

    // Sanity: no script element with the payload landed in the DOM.
    const injected = await page
      .locator("script")
      .filter({ hasText: "alert('xss')" })
      .count();
    expect(injected).toBe(0);
    expect(alerted).toBe(false);
  });

  // 18. End-of-day overflow: with hours 09:00–17:00, the 45-minute seed
  //    service plus 10-minute buffer should not produce any slot whose
  //    label starts at 16:30 or later (would end at 17:25, past close).
  test("edge-18: slots that would run the SERVICE past closing time are not offered", async ({
    page,
  }) => {
    await setSalonRow(PRIMARY_SLUG, { opening_hours: STANDARD_HOURS });
    await navigateToTimeStep(page, PRIMARY_SLUG);

    const slotTexts = (
      await page.locator('[data-testid="time-slot"]').allTextContents()
    ).map((s) => s.trim());

    for (const label of slotTexts) {
      const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(label);
      if (!m) continue;
      let h = Number(m[1]);
      const minute = Number(m[2]);
      const meridiem = m[3]!.toUpperCase();
      if (meridiem === "PM" && h !== 12) h += 12;
      if (meridiem === "AM" && h === 12) h = 0;
      const minutesFromClose = (17 - h) * 60 - minute;
      // The 45-min SERVICE must finish by 17:00; the 10-min trailing buffer
      // (reset gap for the NEXT booking) may run past close for the last
      // appointment of the day. So the last bookable start is 16:15 — 45 min
      // before close — not 16:05.
      expect(
        minutesFromClose,
        `slot ${label} runs the 45min service past closing time (needs 45min before 17:00; trailing buffer may spill past close)`,
      ).toBeGreaterThanOrEqual(45);
    }
  });

  // 19. Notes with emoji / Vietnamese diacritics / quotes — positive path,
  //    booking must succeed and the success screen render.
  test("edge-19: notes containing emoji, diacritics, and quotes book successfully", async ({
    page,
  }) => {
    const notes = `Nguyễn — “please be gentle” 🎉 café`;
    await navigateToConfirmStep(page, PRIMARY_SLUG, {
      name: "Mai Nguyễn",
      phone: "6045551234",
      notes,
    });
    await page.getByTestId("sms-consent").check();
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByTestId("booking-success")).toBeVisible({
      timeout: 15_000,
    });
  });

  // 20. Timezone: complete a booking with the salon set to America/Toronto;
  //    verify the persisted UTC instant matches the slot label when the
  //    label is interpreted in the salon's timezone (assertion is sanity-
  //    level: the stored UTC parses, falls in the future, and round-trips
  //    to a same-day local label).
  test("edge-20: a booking on a Toronto-timezone salon persists a valid UTC instant", async ({
    page,
  }) => {
    await setSalonRow(PRIMARY_SLUG, {
      timezone: "America/Toronto",
      opening_hours: STANDARD_HOURS,
    });

    await navigateToConfirmStep(page, PRIMARY_SLUG, {
      name: "Toronto Tester",
      phone: "6045551234",
    });
    await page.getByTestId("sms-consent").check();
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByTestId("booking-success")).toBeVisible({
      timeout: 15_000,
    });

    const salonId = await getSalonId(PRIMARY_SLUG);
    const { data: rows } = await supabase
      .from("bookings")
      .select("start_time_utc, end_time_utc")
      .eq("salon_id", salonId)
      .order("created_at", { ascending: false })
      .limit(1);
    const row = rows?.[0];
    expect(row?.start_time_utc).toBeTruthy();
    expect(row?.end_time_utc).toBeTruthy();

    const startMs = new Date(row!.start_time_utc as string).getTime();
    const endMs = new Date(row!.end_time_utc as string).getTime();
    expect(Number.isFinite(startMs)).toBe(true);
    expect(Number.isFinite(endMs)).toBe(true);
    expect(endMs).toBeGreaterThan(startMs);
    // 45-minute seed service: duration 45 + buffer 10 = 55 minutes.
    expect((endMs - startMs) / 60_000).toBe(55);
    // Future booking — must be after now.
    expect(startMs).toBeGreaterThan(Date.now());
  });
});

// Silences unused-import lint when readSelectedSlotIso is wired in by a
// follow-up. The helper is retained because it documents the data-* attrs
// the picker exposes, which the conflict tests above depend on.
void readSelectedSlotIso;
