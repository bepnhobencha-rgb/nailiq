/**
 * Bed/Room picker E2E tests — receptionist center (New Appt + Edit Booking).
 *
 * Fixture: a resource-mode salon (resources_enabled=true) with 3 beds and
 * one pre-existing booking on Bed 1 at 11:00–12:00 UTC to exercise the ✗
 * busy state.
 *
 * Regression covered:
 *   • Stale closure bug: useCallback for submit was missing `resourceId` +
 *     `data` from deps → bed selection updated the UI but was silently ignored
 *     on submit (PR #663).
 */

import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { cleanupTestSalon } from "../helpers/db";
import {
  fillReactInput,
  gotoReceptionistCenter,
  isoAtUtcYmdHourMinute,
} from "./helpers";

// ---------------------------------------------------------------------------
// Supabase admin client (same pattern as helpers.ts)
// ---------------------------------------------------------------------------
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const db = createClient(supabaseUrl, serviceKey);

// ---------------------------------------------------------------------------
// Slug isolation per project + CI run (mirrors rcSlug() pattern)
// ---------------------------------------------------------------------------
const RUN_SUFFIX =
  process.env.GITHUB_RUN_ID ??
  process.env.PLAYWRIGHT_WORKER_INDEX ??
  String(Date.now()).slice(-6);

function bedPickerSlug(project: string): string {
  const base = project === "mobile" ? "e2e-bp-mob" : "e2e-bp-dsk";
  return `${base}-${RUN_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------
interface BedPickerFixture {
  salonId: string;
  slug: string;
  staffId: string;
  serviceId: string;
  /** 60-min service name used in form select */
  serviceName: string;
  staffName: string;
  beds: Array<{ id: string; name: string }>;
  /** Bed 1 — has conflict booking at conflictStartUtc */
  conflictBedId: string;
  conflictBedName: string;
  conflictStartUtc: string;
  conflictEndUtc: string;
  conflictBookingId: string;
  /** Booking pre-seeded on Bed 2 for edit-form tests */
  editBookingId: string;
  editBedId: string;
  editBedName: string;
  freeBedId: string;
  freeBedName: string;
  ymdUtc: string;
}

// ---------------------------------------------------------------------------
// Fixture seeding
// ---------------------------------------------------------------------------
async function seedBedPickerFixture(slug: string): Promise<BedPickerFixture> {
  // Full teardown before re-seeding (idempotent re-runs)
  await cleanupTestSalon(slug);

  // Use tomorrow so slots are always available (salon closes at 21:00 UTC; today's slots
  // would be exhausted if the test runs after that time).
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const ymdUtc = tomorrow.toISOString().slice(0, 10);

  // 1. Salon with resources_enabled
  const { data: salon, error: salonErr } = await db
    .from("salons")
    .insert({
      slug,
      name: "E2E Bed Picker Salon",
      phone: "15559990001",
      profile_complete: true,
      timezone: "UTC",
      address: "1 E2E Bed Lane",
      setup_wizard_completed_at: new Date().toISOString(),
      dashboard_preset: "rush_hour",
      walkin_auto_assign: false,
      resources_enabled: true,
      opening_hours: {
        mon: { open: "09:00", close: "21:00", closed: false },
        tue: { open: "09:00", close: "21:00", closed: false },
        wed: { open: "09:00", close: "21:00", closed: false },
        thu: { open: "09:00", close: "21:00", closed: false },
        fri: { open: "09:00", close: "21:00", closed: false },
        sat: { open: "09:00", close: "21:00", closed: false },
        sun: { open: "09:00", close: "21:00", closed: false },
      },
    } as never)
    .select("id")
    .single();

  if (salonErr ?? !salon?.id) {
    throw new Error(`seedBedPickerFixture salon: ${salonErr?.message ?? "no id"}`);
  }
  const salonId = salon.id as string;

  // Wait for salon to be visible on a fresh PostgREST connection
  for (let i = 0; i < 10; i++) {
    const { count } = await db
      .from("salons")
      .select("*", { count: "exact", head: true })
      .eq("id", salonId);
    if ((count ?? 0) > 0) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  // 2. Service (60 min — produces 60-min slots)
  const serviceName = "E2E Head Spa Classic";
  const { data: svcRow, error: svcErr } = await db
    .from("services")
    .insert({
      salon_id: salonId,
      name: serviceName,
      duration_minutes: 60,
      buffer_minutes: 0,
      price_cents: 8500,
    })
    .select("id")
    .single();
  if (svcErr ?? !svcRow?.id) throw new Error(`service: ${svcErr?.message}`);
  const serviceId = svcRow.id as string;

  // 3. Staff
  const staffName = "Alex";
  const { data: staffRow, error: staffErr } = await db
    .from("staff")
    .insert({ salon_id: salonId, name: staffName, job_role: "nail_tech" })
    .select("id")
    .single();
  if (staffErr ?? !staffRow?.id) throw new Error(`staff: ${staffErr?.message}`);
  const staffId = staffRow.id as string;

  // Staff-service capability
  await db.from("staff_services").insert({ staff_id: staffId, service_id: serviceId });

  // 3b. Bot staff — holds the conflict booking so Alex stays free at 11:00 AM.
  //     (Using the SAME staff for the conflict booking would mark Alex busy at 11:00,
  //     hiding the 11:00 AM slot from the available-slot list entirely.)
  const { data: botStaffRow, error: botStaffErr } = await db
    .from("staff")
    .insert({ salon_id: salonId, name: "Bot Staff", job_role: "nail_tech" })
    .select("id")
    .single();
  if (botStaffErr ?? !botStaffRow?.id) throw new Error(`bot staff: ${botStaffErr?.message}`);
  const botStaffId = botStaffRow.id as string;

  // 4. Beds (3)
  const bedSpecs = [
    { name: "Bed 1", display_order: 1 },
    { name: "Bed 2", display_order: 2 },
    { name: "Bed 3", display_order: 3 },
  ];
  const { data: bedRows, error: bedErr } = await db
    .from("salon_resources")
    .insert(
      bedSpecs.map((b) => ({
        salon_id: salonId,
        name: b.name,
        display_order: b.display_order,
        status: "active",
      })),
    )
    .select("id, name");
  if (bedErr ?? !bedRows?.length) throw new Error(`beds: ${bedErr?.message}`);
  const beds = bedRows as Array<{ id: string; name: string }>;

  const conflictBed = beds[0]!;
  const editBed = beds[1]!;   // Bed 2 — pre-seeded booking for edit tests
  const freeBed = beds[2]!;   // Bed 3 — free, good target for "change to"

  // 5. Conflict booking: Bed 1 at 11:00–12:00 UTC, assigned to Bot Staff (not Alex)
  //    so Alex remains free at 11:00 AM and the slot appears in the picker. The
  //    bed-availability check (getResourceAvailability) still marks Bed 1 as ✗.
  const conflictStart = isoAtUtcYmdHourMinute(ymdUtc, 11, 0);
  const conflictEnd = isoAtUtcYmdHourMinute(ymdUtc, 12, 0);
  const { data: conflictRow, error: conflictErr } = await db
    .from("bookings")
    .insert({
      salon_id: salonId,
      service_id: serviceId,
      client_name: "E2E Conflict Holder",
      staff_id: botStaffId,
      start_time_utc: conflictStart,
      end_time_utc: conflictEnd,
      status: "confirmed",
      source: "appointment",
      resource_id: conflictBed.id,
      price_cents: 8500,
    })
    .select("id")
    .single();
  if (conflictErr ?? !conflictRow?.id) throw new Error(`conflict booking: ${conflictErr?.message}`);

  // 6. Edit-target booking: Bed 2 at 14:00–15:00 UTC, on Alex (staffId).
  //    Test 5 avoids this slot by using 12 PM / 1 PM instead of 2 PM / 3 PM.
  const editStart = isoAtUtcYmdHourMinute(ymdUtc, 14, 0);
  const editEnd = isoAtUtcYmdHourMinute(ymdUtc, 15, 0);
  const { data: editRow, error: editErr } = await db
    .from("bookings")
    .insert({
      salon_id: salonId,
      service_id: serviceId,
      client_name: "E2E Edit Target",
      staff_id: staffId,
      start_time_utc: editStart,
      end_time_utc: editEnd,
      status: "confirmed",
      source: "appointment",
      resource_id: editBed.id,
      price_cents: 8500,
    })
    .select("id")
    .single();
  if (editErr ?? !editRow?.id) throw new Error(`edit booking: ${editErr?.message}`);

  return {
    salonId,
    slug,
    staffId,
    serviceId,
    serviceName,
    staffName,
    beds,
    conflictBedId: conflictBed.id,
    conflictBedName: conflictBed.name,
    conflictStartUtc: conflictStart,
    conflictEndUtc: conflictEnd,
    conflictBookingId: conflictRow.id as string,
    editBookingId: editRow.id as string,
    editBedId: editBed.id,
    editBedName: editBed.name,
    freeBedId: freeBed.id,
    freeBedName: freeBed.name,
    ymdUtc,
  };
}

// ---------------------------------------------------------------------------
// Helpers for form interaction
// ---------------------------------------------------------------------------

/** Open the "+ New appt" modal and fill phone + name. */
async function openNewApptModal(
  page: import("@playwright/test").Page,
  opts: { phone?: string; clientName: string },
) {
  await page.getByTestId("header-add-appointment").evaluate((el: HTMLElement) => el.click());
  // Wait for modal to mount
  await page.locator('button:has-text("Create appointment")').waitFor({ state: "attached", timeout: 15_000 });

  // Phone — modal input has inputmode="tel" (walk-in input has type="tel")
  const phoneInput = page.locator('input[inputmode="tel"]');
  await fillReactInput(phoneInput, opts.phone ?? "+16045550042");

  // Customer name — first autocomplete="off" input in the modal
  const nameInput = page.locator('input[autocomplete="off"]').first();
  await fillReactInput(nameInput, opts.clientName);
}

/** Select service and staff in the New Appt modal, wait for time slots to load. */
async function fillServiceAndStaff(
  page: import("@playwright/test").Page,
  fx: BedPickerFixture,
) {
  // Service — select has "— Select a service —" as first option
  await page
    .locator('select:has(option:text-is("— Select a service —"))')
    .selectOption({ label: `${fx.serviceName} · $85.00` });

  // Staff — the modal's staff select does NOT have data-testid; exclude walk-in select
  await page
    .locator('select:has(option:text-is("' + fx.staffName + '")):not([data-testid])')
    .selectOption({ label: fx.staffName });

  // Wait for time slots to appear
  await page
    .locator('button')
    .filter({ hasText: /^\d{1,2}:\d{2} (PM|AM)$/ })
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
}

/** Click a time slot button by its label (e.g. "10:00 AM"). */
async function clickTimeSlot(
  page: import("@playwright/test").Page,
  label: string,
) {
  // Buttons are inside the modal overlay — use evaluate to bypass potential
  // overflow-clip issues the same way RC helpers do for other click targets.
  const btn = page.locator("button").filter({ hasText: new RegExp(`^${label}$`) }).first();
  await btn.waitFor({ state: "visible", timeout: 10_000 });
  await btn.evaluate((el: HTMLElement) => el.click());
}

/** Wait for the bed picker to finish loading (loading spinner gone, Auto button visible). */
async function waitForBedPicker(page: import("@playwright/test").Page, prefix: "desk" | "edit") {
  // Loading state disappears
  await page.locator(`[data-testid="${prefix}-bed-loading"]`).waitFor({ state: "detached", timeout: 10_000 }).catch(() => {
    // Already gone (fast network) — OK
  });
  // Auto button appears (means picker rendered)
  await page.locator(`[data-testid="${prefix}-bed-auto"]`).waitFor({ state: "visible", timeout: 10_000 });
}

/** Query Supabase for the resource_id of a booking by client name. */
async function fetchResourceId(salonId: string, clientName: string): Promise<string | null> {
  const { data } = await db
    .from("bookings")
    .select("resource_id")
    .eq("salon_id", salonId)
    .eq("client_name", clientName)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { resource_id?: string | null } | null)?.resource_id ?? null;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let fx: BedPickerFixture;

test.beforeAll(async ({}, testInfo) => {
  fx = await seedBedPickerFixture(bedPickerSlug(testInfo.project.name));
});

test.afterAll(async ({}, testInfo) => {
  const slug = bedPickerSlug(testInfo.project.name);
  // Explicitly remove salon_resources before cleanupTestSalon (FK safety)
  const { data: salon } = await db.from("salons").select("id").eq("slug", slug).maybeSingle();
  if (salon?.id) {
    await db.from("salon_resources").delete().eq("salon_id", salon.id as string);
  }
  await cleanupTestSalon(slug);
});

// ─── New Appt form ────────────────────────────────────────────────────────────

test.describe("New Appt — bed picker", () => {
  test("bed picker renders after slot selection", async ({ page }) => {
    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc, expectWalkinQueue: false });
    await openNewApptModal(page, { clientName: "E2E Render Check" });
    await fillServiceAndStaff(page, fx);

    // Bed picker must NOT be visible yet (no slot selected)
    await expect(page.locator('[data-testid="desk-bed-picker"]')).not.toBeVisible();

    // Click any free slot (10:00 AM — before the 11:00 conflict)
    await clickTimeSlot(page, "10:00 AM");
    await waitForBedPicker(page, "desk");

    await expect(page.locator('[data-testid="desk-bed-picker"]')).toBeVisible();
    await expect(page.locator('[data-testid="desk-bed-auto"]')).toBeVisible();
  });

  test("busy bed shows ✗ disabled, free beds show ✓", async ({ page }) => {
    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc, expectWalkinQueue: false });
    await openNewApptModal(page, { clientName: "E2E Avail Check" });
    await fillServiceAndStaff(page, fx);

    // Click 11:00 AM — overlaps with conflict booking on Bed 1
    await clickTimeSlot(page, "11:00 AM");
    await waitForBedPicker(page, "desk");

    // Bed 1 (conflict) must show ✗ and be disabled
    const conflictBtn = page.locator(`[data-testid="desk-bed-${fx.conflictBedId}"]`);
    await expect(conflictBtn).toBeVisible();
    await expect(conflictBtn).toContainText("✗");
    await expect(conflictBtn).toBeDisabled();

    // Bed 2 and Bed 3 must show ✓ and be enabled
    for (const bed of [fx.beds[1]!, fx.beds[2]!]) {
      const btn = page.locator(`[data-testid="desk-bed-${bed.id}"]`);
      await expect(btn).toBeVisible();
      await expect(btn).toContainText("✓");
      await expect(btn).toBeEnabled();
    }
  });

  test("selecting a bed sends correct resourceId on submit — stale closure regression", async ({
    page,
  }) => {
    const clientName = `E2E BedSelect ${Date.now()}`;
    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc, expectWalkinQueue: false });
    await openNewApptModal(page, { clientName });
    await fillServiceAndStaff(page, fx);

    // Use a free slot (10:00 AM — no conflict)
    await clickTimeSlot(page, "10:00 AM");
    await waitForBedPicker(page, "desk");

    // Select Bed 3 (freeBedId)
    const bedBtn = page.locator(`[data-testid="desk-bed-${fx.freeBedId}"]`);
    await expect(bedBtn).toBeEnabled();
    await bedBtn.evaluate((el: HTMLElement) => el.click());

    // Confirm it's now highlighted
    await expect(bedBtn).toHaveClass(/bg-nq-primary/);
    // Auto button must no longer be highlighted
    await expect(page.locator('[data-testid="desk-bed-auto"]')).not.toHaveClass(/bg-nq-primary/);

    // Capture the Server Action request to verify resourceId payload
    const [request] = await Promise.all([
      page.waitForRequest(
        (req) => {
          const pd = req.postData();
          return !!pd && pd.includes('"clientName"');
        },
        { timeout: 15_000 },
      ),
      page.locator('button:has-text("Create appointment")').evaluate((el: HTMLElement) => el.click()),
    ]);

    const payload = JSON.parse(request.postData() ?? "[]")[1] as Record<string, unknown>;
    expect(payload.resourceId).toBe(fx.freeBedId);

    // Also verify DB
    await expect
      .poll(async () => fetchResourceId(fx.salonId, clientName), { timeout: 10_000 })
      .toBe(fx.freeBedId);
  });

  test("Auto (no bed selected) still creates booking and assigns a bed", async ({ page }) => {
    const clientName = `E2E AutoAssign ${Date.now()}`;
    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc, expectWalkinQueue: false });
    await openNewApptModal(page, { clientName });
    await fillServiceAndStaff(page, fx);

    // Use 16:00 — all beds free
    await clickTimeSlot(page, "4:00 PM");
    await waitForBedPicker(page, "desk");

    // Leave Auto selected (do not click any bed)
    await expect(page.locator('[data-testid="desk-bed-auto"]')).toHaveClass(/bg-nq-primary/);

    // Submit
    const [request] = await Promise.all([
      page.waitForRequest(
        (req) => !!req.postData()?.includes('"clientName"'),
        { timeout: 15_000 },
      ),
      page.locator('button:has-text("Create appointment")').evaluate((el: HTMLElement) => el.click()),
    ]);

    const payload = JSON.parse(request.postData() ?? "[]")[1] as Record<string, unknown>;
    // Auto = resourceId null in payload; server auto-assigns
    expect(payload.resourceId).toBeNull();

    // DB must have a non-null resource_id (server picked a bed)
    await expect
      .poll(async () => fetchResourceId(fx.salonId, clientName), { timeout: 10_000 })
      .not.toBeNull();
  });

  test("bed picker resets when time slot changes", async ({ page }) => {
    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc, expectWalkinQueue: false });
    await openNewApptModal(page, { clientName: "E2E Reset Check" });
    await fillServiceAndStaff(page, fx);

    // 12 PM / 1 PM: free for Alex (10 AM + 4 PM booked by tests 3/4; 2 PM = edit-target booking)
    await clickTimeSlot(page, "12:00 PM");
    await waitForBedPicker(page, "desk");

    // Select Bed 3
    await page
      .locator(`[data-testid="desk-bed-${fx.freeBedId}"]`)
      .evaluate((el: HTMLElement) => el.click());
    await expect(
      page.locator(`[data-testid="desk-bed-${fx.freeBedId}"]`),
    ).toHaveClass(/bg-nq-primary/);

    // Change to a different time slot → resourceId should reset to Auto
    await clickTimeSlot(page, "1:00 PM");
    await waitForBedPicker(page, "desk");

    // Auto must be selected again after slot change
    await expect(page.locator('[data-testid="desk-bed-auto"]')).toHaveClass(/bg-nq-primary/);
    await expect(
      page.locator(`[data-testid="desk-bed-${fx.freeBedId}"]`),
    ).not.toHaveClass(/bg-nq-primary/);
  });
});

// ─── Edit Booking form ─────────────────────────────────────────────────────────

test.describe("Edit Booking — bed picker", () => {
  /** Click the edit-target booking chip in the grid and open the Edit panel. */
  async function openEditFormForEditTarget(page: import("@playwright/test").Page) {
    const chip = page.locator(`[data-testid="booking-block-${fx.editBookingId}"]`);
    await chip.waitFor({ state: "visible", timeout: 15_000 });
    await chip.evaluate((el: HTMLElement) => el.click());
    // Wait for booking drawer
    await page.locator('button:has-text("Edit")').waitFor({ state: "visible", timeout: 10_000 });
    await page.locator('button:has-text("Edit")').evaluate((el: HTMLElement) => el.click());
    // Wait for Edit form
    await page.getByTestId("edit-booking-form").waitFor({ state: "visible", timeout: 15_000 });
  }

  test("edit form pre-selects current bed", async ({ page }) => {
    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc, expectWalkinQueue: false });
    await openEditFormForEditTarget(page);

    // Wait for bed picker to load (shows current bed)
    await waitForBedPicker(page, "edit");

    // The edit-target booking is on editBedId — should be pre-selected (gold)
    const currentBedBtn = page.locator(`[data-testid="edit-bed-${fx.editBedId}"]`);
    await expect(currentBedBtn).toHaveClass(/bg-nq-primary/, { timeout: 10_000 });
    // Auto must NOT be selected
    await expect(page.locator('[data-testid="edit-bed-auto"]')).not.toHaveClass(/bg-nq-primary/);
  });

  test("changing bed in edit form updates resource_id in DB", async ({ page }) => {
    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc, expectWalkinQueue: false });
    await openEditFormForEditTarget(page);
    await waitForBedPicker(page, "edit");

    // Switch from editBedId (Bed 2) → freeBedId (Bed 3)
    const freeBedBtn = page.locator(`[data-testid="edit-bed-${fx.freeBedId}"]`);
    await expect(freeBedBtn).toBeEnabled();
    await freeBedBtn.evaluate((el: HTMLElement) => el.click());
    await expect(freeBedBtn).toHaveClass(/bg-nq-primary/);

    // Save
    await page.getByTestId("edit-save-button").evaluate((el: HTMLElement) => el.click());
    // Wait for drawer to close (form unmounts)
    await page.getByTestId("edit-booking-form").waitFor({ state: "detached", timeout: 15_000 });

    // DB must reflect new bed
    const { data } = await db
      .from("bookings")
      .select("resource_id")
      .eq("id", fx.editBookingId)
      .maybeSingle();
    const savedResourceId = (data as { resource_id?: string | null } | null)?.resource_id;
    expect(savedResourceId).toBe(fx.freeBedId);
  });
});
