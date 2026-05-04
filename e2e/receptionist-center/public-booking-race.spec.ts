import { test, expect } from "@playwright/test";

import { salonToday, salonWallTimeToUtcIso } from "@/shared/lib/salonTime";
import {
  DEFAULT_OPENING_HOURS_JSON,
  type DayKey,
  parseOpeningHours,
} from "@/shared/dashboard/openingHoursDefaults";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  clickAssignSlot,
  countBookingsForClient,
  getBookingRow,
  fillWalkinGuestContact,
  gotoReceptionistCenter,
  RECEPTIONIST_E2E_SLUG,
  seedDeskBooking,
  seedReceptionistCenterFixture,
  seedWalkin,
  supabaseAdmin,
  testClientNameMarker,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;

const GRID_HOUR_START = 8;
const SLOT_MINUTES = 30;
/** E2E Gel Manicure: 45 + 10 buffer (matches seed). */
const PRIMARY_SERVICE_TOTAL_MIN = 55;

const defaultWeek = parseOpeningHours(JSON.parse(DEFAULT_OPENING_HOURS_JSON));

function addUtcCalendarDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + days));
  return x.toISOString().slice(0, 10);
}

/** `Date.getUTCDay()` order: 0 Sun … 6 Sat */
const UTC_DOW_TO_DAY_KEY: readonly DayKey[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

function utcYmdDayKey(ymd: string): DayKey {
  const [y, mo, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return UTC_DOW_TO_DAY_KEY[dow]!;
}

/**
 * Next calendar day (from `baseYmd`) where the default fixture opening_hours are open
 * and grid slot `slotIndex` (noon = 8) starts at or after `minStartMs`.
 */
function pickBookableDateYmd(args: {
  baseYmd: string;
  timezone: string;
  slotIndex: number;
  minStartMs: number;
}): string {
  if (!defaultWeek) throw new Error("public-booking-race: default opening hours invalid");
  const minutesFromMidnight = GRID_HOUR_START * 60 + args.slotIndex * SLOT_MINUTES;

  for (let i = 0; i < 14; i++) {
    const ymd = addUtcCalendarDays(args.baseYmd, i);
    const cfg = defaultWeek[utcYmdDayKey(ymd)];
    if (!cfg || cfg.closed) continue;

    const startIso = salonWallTimeToUtcIso(ymd, minutesFromMidnight, args.timezone);
    if (Date.parse(startIso) >= args.minStartMs) return ymd;
  }

  throw new Error("public-booking-race: no bookable day in window");
}

/**
 * Desk walk-in UI only renders on salon "today". Pick today only if the grid slot is still in the future.
 */
function pickBookableDateYmdTodayOnly(args: {
  timezone: string;
  slotIndex: number;
  minStartMs: number;
}): string | null {
  if (!defaultWeek) return null;
  const ymd = salonToday(args.timezone);
  const minutesFromMidnight = GRID_HOUR_START * 60 + args.slotIndex * SLOT_MINUTES;
  const cfg = defaultWeek[utcYmdDayKey(ymd)];
  if (!cfg || cfg.closed) return null;
  const startIso = salonWallTimeToUtcIso(ymd, minutesFromMidnight, args.timezone);
  if (Date.parse(startIso) >= args.minStartMs) return ymd;
  return null;
}

function slotBoundsForDate(
  dateYmd: string,
  slotIndex: number,
  timezone: string,
  totalMinutes: number,
): { startIso: string; endIso: string } {
  const minutesFromMidnight = GRID_HOUR_START * 60 + slotIndex * SLOT_MINUTES;
  const startIso = salonWallTimeToUtcIso(dateYmd, minutesFromMidnight, timezone);
  const endIso = new Date(Date.parse(startIso) + totalMinutes * 60_000).toISOString();
  return { startIso, endIso };
}

function rpcShowsSlotConflict(
  data: unknown,
  error: { message?: string; code?: string } | null,
): boolean {
  if (error) {
    const m = String(error.message ?? "").toLowerCase();
    const c = String(error.code ?? "").toLowerCase();
    return (
      m.includes("slot_conflict") || m.includes("exclusion") || c === "23p01"
    );
  }
  if (
    data &&
    typeof data === "object" &&
    (data as { success?: boolean }).success === false &&
    String((data as { code?: string }).code ?? "") === "slot_conflict"
  ) {
    return true;
  }
  return false;
}

test.beforeAll(async () => {
  fx = await seedReceptionistCenterFixture();
});

test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});

test.afterEach(async () => {
  await cleanReceptionistData(fx.salonId);
});

test.afterAll(async () => {
  await cleanupTestSalon(RECEPTIONIST_E2E_SLUG);
});

test.describe("race-1: walk-in assigned then public RPC same slot", () => {
  test("rejects create_public_booking with slot_conflict; walk-in is the only client booking", async () => {
    const minStartMs = Date.now() + 3 * 60_000;
    const dateYmd = pickBookableDateYmd({
      baseYmd: fx.ymdUtc,
      timezone: fx.timezone,
      slotIndex: fx.noonSlotIndex,
      minStartMs,
    });

    const { startIso, endIso } = slotBoundsForDate(
      dateYmd,
      fx.noonSlotIndex,
      fx.timezone,
      PRIMARY_SERVICE_TOTAL_MIN,
    );

    const walkinName = testClientNameMarker();
    const walkinId = await seedWalkin(fx.salonId, {
      clientName: walkinName,
      serviceId: fx.serviceIds[0]!,
    });

    const { data: assigned, error: upErr } = await supabaseAdmin
      .from("bookings")
      .update({
        staff_id: fx.freeStaffId,
        start_time_utc: startIso,
        end_time_utc: endIso,
        status: "confirmed",
      })
      .eq("id", walkinId)
      .eq("salon_id", fx.salonId)
      .eq("source", "walkin")
      .eq("status", "waiting")
      .select("start_time_utc, end_time_utc, staff_id, service_id, status")
      .maybeSingle();

    expect(upErr).toBeNull();
    expect(assigned?.status).toBe("confirmed");

    const pStart = String(assigned?.start_time_utc ?? "");
    const pEnd = String(assigned?.end_time_utc ?? "");
    const staffId = String(assigned?.staff_id ?? "");
    const serviceId = String(assigned?.service_id ?? "");
    expect(pStart && pEnd && staffId && serviceId).toBeTruthy();

    const publicName = `TEST_E2E_PUB_${Date.now()}`;
    const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc("create_public_booking", {
      p_salon_id: fx.salonId,
      p_service_id: serviceId,
      p_staff_id: staffId,
      p_client_name: publicName,
      p_client_phone: "15551112233",
      p_start_time_utc: pStart,
      p_end_time_utc: pEnd,
      p_status: "pending",
      p_price_cents: 4500,
      p_client_notes: null,
      p_addon_service_id: null,
      p_addon_price_cents: null,
    });

    expect(
      rpcShowsSlotConflict(rpcData, rpcError),
      `expected slot_conflict; data=${JSON.stringify(rpcData)} err=${rpcError?.message} code=${rpcError?.code}`,
    ).toBe(true);

    await expect(countBookingsForClient(fx.salonId, publicName)).resolves.toBe(0);
    await expect(countBookingsForClient(fx.salonId, walkinName)).resolves.toBe(1);
  });
});

test.describe("race-2: appointment blocks walk-in assign same slot", () => {
  test("desk shows conflict toast; walk-in stays waiting; no grid block", async ({ page }, testInfo) => {
    const minStartMs = Date.now() + 3 * 60_000;
    const dateYmd = pickBookableDateYmdTodayOnly({
      timezone: fx.timezone,
      slotIndex: fx.noonSlotIndex,
      minStartMs,
    });
    if (!dateYmd) {
      testInfo.skip(true, "No future noon slot left on salon today; walk-in sidebar is today-only.");
      return;
    }

    const apptName = testClientNameMarker();
    const { startIso, endIso } = slotBoundsForDate(
      dateYmd,
      fx.noonSlotIndex,
      fx.timezone,
      PRIMARY_SERVICE_TOTAL_MIN,
    );

    await seedDeskBooking(fx.salonId, {
      clientName: apptName,
      serviceId: fx.serviceIds[0]!,
      staffId: fx.freeStaffId,
      startIso,
      endIso,
      status: "confirmed",
      source: "appointment",
    });

    await gotoReceptionistCenter(page, fx.slug, { dateYmd });

    const walkinName = testClientNameMarker();

    await fillWalkinGuestContact(page, walkinName);
    await page.locator(`#walkin-service-${fx.serviceIds[0]}`).click();
    await page.getByTestId("walkin-add-form").locator('button[type="submit"]').click();

    const row = page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: walkinName });
    await expect(row).toBeVisible({ timeout: 15_000 });
    const tid = await row.getAttribute("data-testid");
    const walkinBookingId = tid?.replace(/^queue-item-/, "") ?? "";

    await page.getByTestId(`queue-assign-${walkinBookingId}`).click();
    await clickAssignSlot(page, fx.freeStaffId, fx.noonSlotIndex);

    const deskMsg = page.getByTestId("desk-action-message");
    await expect(deskMsg).toBeVisible({ timeout: 12_000 });
    await expect(deskMsg).toContainText(apptName);

    await expect(page.getByTestId(`queue-item-${walkinBookingId}`)).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId(`booking-block-${walkinBookingId}`)).toHaveCount(0);

    const rowState = await getBookingRow(fx.salonId, walkinBookingId);
    expect(rowState?.status).toBe("waiting");
  });
});
