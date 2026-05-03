import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { DEFAULT_OPENING_HOURS_JSON } from "@/shared/dashboard/openingHoursDefaults";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl?.trim() || !serviceKey?.trim()) {
  throw new Error(
    "e2e/receptionist-center/helpers requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (e.g. .env.local / .env.test.local)",
  );
}

export const supabaseAdmin = createClient(supabaseUrl, serviceKey);

/** Stable slug for Receptionist Center e2e — full teardown via `cleanupTestSalon` after suites. */
export const RECEPTIONIST_E2E_SLUG = "e2e-receptionist-center";

export function testClientNameMarker(): string {
  return `TEST_E2E_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

/** Deletes walk-ins and desk rows created by tests (client_name prefix `TEST_E2E_`). */
export async function cleanReceptionistData(salonId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("bookings")
    .delete()
    .eq("salon_id", salonId)
    .like("client_name", "TEST_E2E_%");
  if (error) throw new Error(`cleanReceptionistData: ${error.message}`);
}

export type ReceptionistCenterFixture = {
  salonId: string;
  slug: string;
  timezone: string;
  staffIds: string[];
  /** Six services; index 5 is long duration for overflow ghost tests */
  serviceIds: string[];
  ymdUtc: string;
  /** Staff column 0 holds a confirmed booking at 10:00 UTC — slot index 4 conflicts */
  conflictStaffId: string;
  conflictSlotIndex: number;
  /** Confirmed appointment for “existing booking renders” */
  displayApptBookingId: string;
  displayApptClientName: string;
  /** Staff with no baseline bookings — safe assign target */
  freeStaffId: string;
  /** Slot index for 12:00 (free assign) */
  noonSlotIndex: number;
  /** Last slot index (late afternoon) + long service → overflow ghost */
  overflowSlotIndex: number;
  longServiceId: string;
};

function utcDayBoundsYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isoAtUtcYmdHourMinute(
  ymd: string,
  hour: number,
  minute: number,
): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour, minute, 0)).toISOString();
}

async function fetchServicePrice(
  salonId: string,
  serviceId: string,
): Promise<number | null> {
  const { data: svc } = await supabaseAdmin
    .from("services")
    .select("price_cents")
    .eq("id", serviceId)
    .eq("salon_id", salonId)
    .maybeSingle();
  const raw = svc?.price_cents;
  const price = raw != null ? Math.round(Number(raw)) : null;
  return Number.isFinite(price ?? NaN) ? price : null;
}

/** Full salon + catalog + baseline desk bookings (non–TEST_E2E names). */
export async function seedReceptionistCenterFixture(): Promise<ReceptionistCenterFixture> {
  const slug = RECEPTIONIST_E2E_SLUG;
  const { cleanupTestSalon } = await import("../helpers/db");
  await cleanupTestSalon(slug);

  const ymdUtc = utcDayBoundsYmd();
  const tz = "UTC";

  const openingParsed: unknown = JSON.parse(DEFAULT_OPENING_HOURS_JSON);

  const { data: salon, error: salonErr } = await supabaseAdmin
    .from("salons")
    .insert({
      slug,
      name: "E2E Receptionist Center Salon",
      phone: "15558887777",
      profile_complete: true,
      timezone: tz,
      address: "123 E2E Receptionist Lane",
      opening_hours: openingParsed,
    })
    .select("id")
    .single();

  if (salonErr || !salon?.id) {
    throw new Error(salonErr?.message ?? "seedReceptionistCenterFixture: salon insert failed");
  }

  const salonId = salon.id as string;

  const serviceSpecs = [
    { name: "E2E Gel Manicure", duration_minutes: 45, buffer_minutes: 10, price_cents: 4500 },
    { name: "E2E Polish Change", duration_minutes: 30, buffer_minutes: 10, price_cents: 2500 },
    { name: "E2E Deluxe Pedicure", duration_minutes: 60, buffer_minutes: 15, price_cents: 6500 },
    { name: "E2E Acrylic Full Set", duration_minutes: 90, buffer_minutes: 15, price_cents: 8500 },
    { name: "E2E Quick Trim", duration_minutes: 20, buffer_minutes: 5, price_cents: 1500 },
    {
      name: "E2E Long Overflow Service",
      duration_minutes: 240,
      buffer_minutes: 0,
      price_cents: 12000,
    },
  ];

  const { data: svcRows, error: svcErr } = await supabaseAdmin
    .from("services")
    .insert(
      serviceSpecs.map((s) => ({
        salon_id: salonId,
        name: s.name,
        duration_minutes: s.duration_minutes,
        buffer_minutes: s.buffer_minutes,
        price_cents: s.price_cents,
      })),
    )
    .select("id");

  if (svcErr || !svcRows?.length) {
    await supabaseAdmin.from("salons").delete().eq("id", salonId);
    throw new Error(svcErr?.message ?? "seedReceptionistCenterFixture: services insert failed");
  }

  const serviceIds = svcRows.map((r) => r.id as string);

  const staffSpecs = [
    { name: "Riley", job_role: "owner" },
    { name: "Sam", job_role: "senior" },
    { name: "Taylor", job_role: "nail_tech" },
    { name: "Jordan", job_role: "nail_tech" },
    { name: "Casey", job_role: "nail_tech" },
  ];

  const { data: staffRows, error: staffErr } = await supabaseAdmin
    .from("staff")
    .insert(staffSpecs.map((s) => ({ salon_id: salonId, name: s.name, job_role: s.job_role })))
    .select("id");

  if (staffErr || !staffRows?.length) {
    await supabaseAdmin.from("services").delete().eq("salon_id", salonId);
    await supabaseAdmin.from("salons").delete().eq("id", salonId);
    throw new Error(staffErr?.message ?? "seedReceptionistCenterFixture: staff insert failed");
  }

  const staffIds = staffRows.map((r) => r.id as string);

  const conflictStaffId = staffIds[0]!;
  const freeStaffId = staffIds[1]!;
  const displayStaffId = staffIds[3]!;

  const s0 = serviceIds[0]!;

  const insertBooking = async (args: {
    clientName: string;
    staffId: string;
    serviceId: string;
    start: string;
    end: string;
    status: "pending" | "confirmed" | "in_progress" | "completed";
  }) => {
    const price = await fetchServicePrice(salonId, args.serviceId);
    const { error } = await supabaseAdmin.from("bookings").insert({
      salon_id: salonId,
      service_id: args.serviceId,
      client_name: args.clientName,
      client_phone: null,
      client_notes: null,
      staff_id: args.staffId,
      start_time_utc: args.start,
      end_time_utc: args.end,
      status: args.status,
      source: "appointment",
      joined_queue_at: null,
      staff_request_note: null,
      price_cents: price,
    });
    if (error) throw new Error(`seed baseline booking: ${error.message}`);
  };

  await insertBooking({
    clientName: "RC Baseline Completed",
    staffId: staffIds[2]!,
    serviceId: s0,
    start: isoAtUtcYmdHourMinute(ymdUtc, 8, 30),
    end: isoAtUtcYmdHourMinute(ymdUtc, 9, 25),
    status: "completed",
  });

  await insertBooking({
    clientName: "RC Conflict Anchor",
    staffId: conflictStaffId,
    serviceId: s0,
    start: isoAtUtcYmdHourMinute(ymdUtc, 10, 0),
    end: isoAtUtcYmdHourMinute(ymdUtc, 10, 55),
    status: "confirmed",
  });

  const displayApptClientName = "RC Display Appt";
  await insertBooking({
    clientName: displayApptClientName,
    staffId: displayStaffId,
    serviceId: s0,
    start: isoAtUtcYmdHourMinute(ymdUtc, 12, 0),
    end: isoAtUtcYmdHourMinute(ymdUtc, 12, 55),
    status: "confirmed",
  });

  await insertBooking({
    clientName: "RC Baseline In Progress",
    staffId: staffIds[4]!,
    serviceId: s0,
    start: isoAtUtcYmdHourMinute(ymdUtc, 15, 0),
    end: isoAtUtcYmdHourMinute(ymdUtc, 15, 55),
    status: "in_progress",
  });

  const { data: apptRow } = await supabaseAdmin
    .from("bookings")
    .select("id")
    .eq("salon_id", salonId)
    .eq("client_name", displayApptClientName)
    .maybeSingle();

  const displayApptBookingId = apptRow?.id ? String(apptRow.id) : "";

  if (!displayApptBookingId) {
    throw new Error("seedReceptionistCenterFixture: could not resolve display appt id");
  }

  return {
    salonId,
    slug,
    timezone: tz,
    staffIds,
    serviceIds,
    ymdUtc,
    conflictStaffId,
    conflictSlotIndex: 4,
    displayApptBookingId,
    displayApptClientName,
    freeStaffId,
    noonSlotIndex: 8,
    overflowSlotIndex: 17,
    longServiceId: serviceIds[5]!,
  };
}

export async function seedWalkin(
  salonId: string,
  options: {
    clientName: string;
    serviceId: string;
    clientPhone?: string | null;
    staffRequestNote?: string | null;
    joinedQueueAtIso?: string;
  },
): Promise<string> {
  const price = await fetchServicePrice(salonId, options.serviceId);
  const joined = options.joinedQueueAtIso ?? new Date().toISOString();

  const { data: row, error } = await supabaseAdmin
    .from("bookings")
    .insert({
      salon_id: salonId,
      service_id: options.serviceId,
      client_name: options.clientName,
      client_phone: options.clientPhone ?? null,
      client_notes: null,
      staff_id: null,
      start_time_utc: null,
      end_time_utc: null,
      status: "waiting",
      source: "walkin",
      joined_queue_at: joined,
      staff_request_note: options.staffRequestNote ?? null,
      price_cents: price,
    })
    .select("id")
    .single();

  if (error || !row?.id) throw new Error(error?.message ?? "seedWalkin failed");
  return String(row.id);
}

export async function seedDeskBooking(
  salonId: string,
  options: {
    clientName: string;
    serviceId: string;
    staffId: string;
    startIso: string;
    endIso: string;
    status: "pending" | "confirmed" | "in_progress" | "completed";
    source?: "appointment" | "walkin";
    clientPhone?: string | null;
  },
): Promise<string> {
  const price = await fetchServicePrice(salonId, options.serviceId);

  const { data: row, error } = await supabaseAdmin
    .from("bookings")
    .insert({
      salon_id: salonId,
      service_id: options.serviceId,
      client_name: options.clientName,
      client_phone: options.clientPhone ?? null,
      client_notes: null,
      staff_id: options.staffId,
      start_time_utc: options.startIso,
      end_time_utc: options.endIso,
      status: options.status,
      source: options.source ?? "appointment",
      joined_queue_at: null,
      staff_request_note: null,
      price_cents: price,
    })
    .select("id")
    .single();

  if (error || !row?.id) throw new Error(error?.message ?? "seedDeskBooking failed");
  return String(row.id);
}

export async function countBookingsForClient(
  salonId: string,
  clientName: string,
): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("bookings")
    .select("*", { count: "exact", head: true })
    .eq("salon_id", salonId)
    .eq("client_name", clientName);

  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function fetchBookingDeskSnapshot(
  salonId: string,
  bookingId: string,
): Promise<{
  start_time_utc: string;
  end_time_utc: string;
  staff_id: string | null;
  service_id: string | null;
  price_cents: number | null;
} | null> {
  const { data, error } = await supabaseAdmin
    .from("bookings")
    .select("start_time_utc, end_time_utc, staff_id, service_id, price_cents")
    .eq("salon_id", salonId)
    .eq("id", bookingId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data?.start_time_utc || !data?.end_time_utc) return null;
  return {
    /* Normalize PostgREST `timestamptz` (`+00:00` vs `Z`) for stable test equality. */
    start_time_utc: new Date(String(data.start_time_utc)).toISOString(),
    end_time_utc: new Date(String(data.end_time_utc)).toISOString(),
    staff_id: data.staff_id != null ? String(data.staff_id) : null,
    service_id: data.service_id != null ? String(data.service_id) : null,
    price_cents:
      data.price_cents != null ? Math.round(Number(data.price_cents)) : null,
  };
}

export async function getBookingRow(
  salonId: string,
  bookingId: string,
): Promise<{ status: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from("bookings")
    .select("status")
    .eq("salon_id", salonId)
    .eq("id", bookingId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ?? null;
}

export async function gotoReceptionistCenter(
  page: Page,
  slug: string,
  opts?: { dateYmd?: string },
): Promise<void> {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  let hostname = "localhost";
  try {
    hostname = new URL(baseURL).hostname;
  } catch {
    /* keep localhost */
  }

  await page.context().addCookies([
    {
      name: "nailiq-demo-slug",
      value: slug,
      domain: hostname === "127.0.0.1" ? "127.0.0.1" : hostname === "localhost" ? "localhost" : hostname,
      path: "/",
    },
  ]);

  const q = opts?.dateYmd ? `?date=${encodeURIComponent(opts.dateYmd)}` : "";
  await page.goto(`/dashboard/${encodeURIComponent(slug)}/center${q}`);
  await page.getByTestId("receptionist-center-loaded").waitFor({
    state: "visible",
    timeout: 45_000,
  });
  await page.getByTestId("walkin-add-form").waitFor({ state: "visible" });
}

/** 10-digit test phone satisfying `validateGuestPhone` / public booking rules. */
export const E2E_WALKIN_VALID_PHONE = "5555551234";

/** Fill guest name + phone on the walk-in add form (both required since V1 validation). */
export async function fillWalkinGuestContact(
  page: Page,
  name: string,
  phone = E2E_WALKIN_VALID_PHONE,
): Promise<void> {
  const form = page.getByTestId("walkin-add-form");
  await form.getByTestId("walkin-name").fill(name);
  await form.getByTestId("walkin-phone").fill(phone);
}

/**
 * Receptionist sidebar "Assign" for a walk-in queue row. Prefer over `locator.click()`: Playwright synthetic clicks
 * can miss the React `onClick` when the sidebar stacks under fixed chrome — observed in dual-browser parallel assign runs.
 */
export async function clickWalkinQueueAssign(page: Page, bookingId: string): Promise<void> {
  const loc = page.getByTestId(`queue-assign-${bookingId}`);
  await loc.waitFor({ state: "attached", timeout: 15_000 });
  await loc.scrollIntoViewIfNeeded();
  await loc.evaluate((el: HTMLElement) => {
    el.click();
  });
}

/**
 * Receptionist timeline slot `<button>`s sit under booking blocks (`z-[2]`). Synthetic click reaches React reliably.
 */
export async function clickAssignSlot(
  page: Page,
  staffId: string,
  slotIndex: number,
): Promise<void> {
  const loc = page.getByTestId(`assign-slot-${staffId}-${slotIndex}`);
  await loc.waitFor({ state: "attached", timeout: 15_000 });
  await loc.evaluate((el: HTMLElement) => {
    el.click();
  });
}

/** Move physical cursor over slot (React `onMouseEnter` + ghost state). */
export async function moveMouseToAssignSlot(
  page: Page,
  staffId: string,
  slotIndex: number,
): Promise<void> {
  const slot = page.getByTestId(`assign-slot-${staffId}-${slotIndex}`);
  await slot.waitFor({ state: "attached", timeout: 15_000 });
  await slot.scrollIntoViewIfNeeded();
  // `mouse.move`/`.hover()` are flaky crossing staff rows under scroll/auto-layout.
  // Slot `<button>`s drive the same ghost state via `onFocus` as `onMouseEnter`.
  await slot.focus();
  // Small wait for React state to settle hoveredSlot + ghost subtree
  await page.waitForTimeout(100);
}

export async function gotoOwnerDashboard(page: Page, slug: string): Promise<void> {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  let hostname = "localhost";
  try {
    hostname = new URL(baseURL).hostname;
  } catch {
    /* keep localhost */
  }

  await page.context().addCookies([
    {
      name: "nailiq-demo-slug",
      value: slug,
      domain: hostname === "127.0.0.1" ? "127.0.0.1" : hostname === "localhost" ? "localhost" : hostname,
      path: "/",
    },
  ]);

  await page.goto(`/dashboard/${encodeURIComponent(slug)}`);
  await page.getByRole("heading", { name: /e2e receptionist center salon/i }).waitFor({
    timeout: 30_000,
  });
}
