import type { Locator, Page } from "@playwright/test";
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
  /** Letters + digits only — matches guest `isValidCustomerName` whitelist. */
  return `Te2eGuest${Date.now()}${Math.floor(Math.random() * 1e9)}`;
}

/** Deletes walk-ins and desk rows created by tests (`client_name` prefix `Te2eGuest`). */
export async function cleanReceptionistData(salonId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("bookings")
    .delete()
    .eq("salon_id", salonId)
    .like("client_name", "Te2eGuest%");
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

/**
 * INSERT into `bookings` with a small retry budget on PostgREST FK errors
 * (SQLSTATE 23503). The Supabase pooled connection occasionally serves a
 * subsequent INSERT on a backend whose snapshot has not yet caught up with
 * the just-inserted parent row (salon, staff, service), so the FK trigger
 * misfires even though the parent row IS committed. Retrying with a short
 * backoff lets the visibility window close. Returns the inserted booking id.
 */
async function insertBookingRow(
  payload: Record<string, unknown>,
  label: string,
): Promise<string> {
  let lastError: { code?: string; message: string } | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error } = await supabaseAdmin
      .from("bookings")
      .insert(payload)
      .select("id")
      .single();
    if (!error && data?.id) return String(data.id);
    lastError = error ?? { message: "insert returned no row id" };
    // 23503 = foreign_key_violation. Anything else is a real failure.
    if (error && error.code !== "23503") break;
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  // Probe DB state at the point of giving up so we can tell whether the
  // parent rows are truly gone vs only invisible to PostgREST.
  const salonId = (payload as { salon_id?: string }).salon_id;
  const staffId = (payload as { staff_id?: string | null }).staff_id;
  const serviceId = (payload as { service_id?: string }).service_id;
  const probe = await Promise.all([
    salonId
      ? supabaseAdmin.from("salons").select("*", { count: "exact", head: true }).eq("id", salonId)
      : Promise.resolve({ count: -1 } as { count: number | null }),
    staffId
      ? supabaseAdmin.from("staff").select("*", { count: "exact", head: true }).eq("id", staffId)
      : Promise.resolve({ count: -1 } as { count: number | null }),
    serviceId
      ? supabaseAdmin.from("services").select("*", { count: "exact", head: true }).eq("id", serviceId)
      : Promise.resolve({ count: -1 } as { count: number | null }),
  ]);
  throw new Error(
    `${label}: ${lastError?.message ?? "unknown error"} [code=${lastError?.code ?? "?"} salonHits=${probe[0].count ?? "?"} staffHits=${probe[1].count ?? "?"} svcHits=${probe[2].count ?? "?"}]`,
  );
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

/** Full salon + catalog + baseline desk bookings (non-marker names). */
export async function seedReceptionistCenterFixture(slugOverride?: string): Promise<ReceptionistCenterFixture> {
  const slug = slugOverride ?? RECEPTIONIST_E2E_SLUG;
  const { cleanupTestSalon } = await import("../helpers/db");
  await cleanupTestSalon(slug);

  const ymdUtc = utcDayBoundsYmd();
  const tz = "UTC";

  const openingParsed: unknown = JSON.parse(DEFAULT_OPENING_HOURS_JSON);

  // walkin_auto_assign: false — force queue mode from the start.
  // Default is true: with staff free, canAssignImmediately=true causes the form to
  // immediately assign the walk-in (status=confirmed, appears on grid, NOT in queue panel),
  // breaking every queue-item assertion. Setting it in the INSERT (not a post-insert UPDATE)
  // is more reliable: a separate UPDATE can silently affect 0 rows if PostgREST's schema
  // cache hasn't yet indexed the column, whereas an INSERT value is always written.
  // `as never` cast required since the TypeScript types lag behind the migration.
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
      // Required: the dashboard layout gates access on this being non-null
      // (redirect to /register/setup when null). Without it every RC test
      // would land on the setup wizard instead of the receptionist center.
      setup_wizard_completed_at: new Date().toISOString(),
      // Opt the fixture into the `rush_hour` preset so the receptionist
      // center renders the full UI surface tested by these specs (StatusPill
      // / `kpi_bar` in particular). The product default preset is `reception`
      // which intentionally hides `kpi_bar` — fine for prod but drops the
      // status-pill that several tests rely on. See dashboardPresets.ts.
      dashboard_preset: "rush_hour",
      walkin_auto_assign: false,
    } as never)
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

  // Block until the salon row is consistently readable on a fresh PostgREST
  // connection before issuing any FK-dependent INSERTs (bookings reference
  // salon_id). Empirically the supabase-js / PostgREST round-trip can hand
  // back a `salons` insert response before subsequent INSERTs on a different
  // pooled backend can see the row, producing intermittent
  // `bookings_salon_id_fkey` violations even though the JS client has the
  // new salonId in hand. A read-back loop (10 tries × 500ms = 5s ceiling)
  // is cheaper than retry-on-error inside `insertBooking`, and it scopes
  // the wait to the actual issue (salon visibility, not staff/service ids).
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { count } = await supabaseAdmin
      .from("salons")
      .select("*", { count: "exact", head: true })
      .eq("id", salonId);
    if ((count ?? 0) > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }

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
    const payload = {
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
    };
    return await insertBookingRow(payload, `seed baseline booking (${args.clientName})`);
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
  const displayApptBookingId = await insertBooking({
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

  return await insertBookingRow(
    {
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
    },
    "seedWalkin failed",
  );
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

  return await insertBookingRow(
    {
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
    },
    "seedDeskBooking failed",
  );
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
  opts?: { dateYmd?: string; expectWalkinQueue?: boolean },
): Promise<void> {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

  await page.context().addCookies([
    {
      name: "nailiq-demo-slug",
      value: slug,
      // Use `url` (not `domain`+`path`) — Playwright derives domain/path from
      // the URL, which is more reliable for localhost in Chromium on Linux CI.
      url: baseURL,
    },
  ]);

  // Default the user-language preference to EN before any page script
  // runs. `useUserLanguage` reads `nailiq-user-lang` from localStorage on
  // mount; any leftover "vi" value from a prior test or developer browser
  // would re-render the UI in Vietnamese (e.g. "Chưa hoàn tất setup"
  // instead of "Setup incomplete") and trip exact-text assertions.
  //
  // `setItem` ONLY when no value is already present so locale-specific
  // specs that opt into "vi" via their own `addInitScript` are not
  // overridden — `addInitScript` callbacks run in registration order, and
  // a spec's `presetUserLang("vi")` always runs before this default.
  await page.addInitScript(() => {
    try {
      if (window.localStorage.getItem("nailiq-user-lang") == null) {
        window.localStorage.setItem("nailiq-user-lang", "en");
      }
    } catch {
      /* private mode / quota — ignore, hydration falls back to "en" */
    }
  });

  const q = opts?.dateYmd ? `?date=${encodeURIComponent(opts.dateYmd)}` : "";
  await page.goto(`/dashboard/${encodeURIComponent(slug)}/center${q}`);
  // Next.js streams the receptionist-center-loaded wrapper inside a
  // `<div hidden id="S:N">` Suspense placeholder until hydration. The
  // testid is in the DOM throughout SSR streaming but `state: "visible"`
  // races hydration — for some setups (notably the empty-salon edge case
  // with zero staff + zero services) the wrapper stayed hidden past the
  // 45s timeout. Asserting `attached` instead lets Playwright proceed
  // once SSR has streamed the element; the next two waits below
  // (`staff-timeline-grid`, `walkin-add-form`) require *visible* state
  // and provide the real "fully hydrated" gate.
  // `.first()` — during App Router streaming+hydration, the element can
  // briefly appear twice (SSR placeholder + hydrated copy). Strict-mode
  // `getByTestId` throws on 2 matches; `.first()` is safe because the
  // real gate is the `staff-timeline-grid` visible check below.
  await page.getByTestId("receptionist-center-loaded").first().waitFor({
    state: "attached",
    timeout: 45_000,
  });
  // `.first()` — same streaming-hydration race as `receptionist-center-loaded`
  // above: the grid can briefly appear twice (SSR placeholder + hydrated copy).
  await page.getByTestId("staff-timeline-grid").first().waitFor({
    state: "visible",
    timeout: 45_000,
  });
  if (opts?.expectWalkinQueue !== false) {
    await page.getByTestId("walkin-add-form").waitFor({ state: "visible", timeout: 45_000 });
  }
  // Gate on BookingDetailDrawer's portal mounting. The portal is created
  // inside a useEffect (portalEl = document.body), which only runs after
  // React hydration. The SSR pass renders null (portalEl is null on the
  // server), so "attached" for this testid is a reliable signal that
  // client-side effects have fired and the page is fully interactive.
  // Without this wait, tests on mobile can click booking blocks before
  // React event handlers are registered, causing the drawer to never open.
  await page.getByTestId("booking-detail-drawer").waitFor({
    state: "attached",
    timeout: 30_000,
  });
}

/** 10-digit test phone satisfying `validateGuestPhone` / public booking rules. */
export const E2E_WALKIN_VALID_PHONE = "6045551234";

/**
 * Fill a React-controlled `<input>` using the native HTMLInputElement.prototype
 * value setter + a bubbling InputEvent.
 *
 * Why not `fill()` or `pressSequentially`?
 * • `fill()` writes the value via CDP's setInputFiles / setValue path, which
 *   bypasses React's patched value getter. React memoises the "last seen" value
 *   and skips calling onChange because it thinks nothing changed.
 * • `pressSequentially` fires per-character keyboard events. In headless Chromium
 *   on CI, elements inside an `overflow:hidden` sidebar can lose focus between
 *   characters (the re-render from a progressive phone formatter repositions the
 *   cursor, the browser re-evaluates focus, and subsequent keystrokes land nowhere).
 *
 * The native-setter trick forces React's change-detection to see a real value
 * change; the InputEvent bubbles to the document root where React 18's event
 * delegation calls the component's onChange handler with e.target.value = val.
 */
export async function fillReactInput(
  locator: Locator,
  value: string,
): Promise<void> {
  await locator.evaluate((el: HTMLInputElement, val: string) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
  }, value);
}

/** Fill guest name + phone on the walk-in add form (both required since V1 validation). */
export async function fillWalkinGuestContact(
  page: Page,
  name: string,
  phone = E2E_WALKIN_VALID_PHONE,
): Promise<void> {
  const form = page.getByTestId("walkin-add-form");
  await fillReactInput(form.getByTestId("walkin-name"), name);
  await fillReactInput(form.getByTestId("walkin-phone"), phone);
}

/**
 * Click a walk-in service chip by service ID. Uses evaluate() instead of .click() because
 * the service chip grid sits inside the fixed-height sidebar and can land outside the
 * Playwright viewport — synthetic .click() retries indefinitely when the element is
 * "outside of the viewport", causing 1.5m timeouts on CI (observed for cases 1/2/3/11/12/13).
 */
export async function clickWalkinService(page: Page, serviceId: string): Promise<void> {
  const loc = page.locator(`#walkin-service-${serviceId}`);
  await loc.waitFor({ state: "attached", timeout: 15_000 });
  await loc.evaluate((el: HTMLElement) => {
    el.click();
  });
  // Block until React commits the selection — chip gains border-nq-primary class.
  // Without this wait, clickWalkinSubmit fires against the stale runSubmit closure
  // (selectedServiceId still null) and the form silently aborts.
  await page.locator(`#walkin-service-${serviceId}.border-nq-primary`).waitFor({
    state: "attached",
    timeout: 5_000,
  });
}

/**
 * Submit the walkin form. Waits for the button to be enabled (React may need a tick
 * to commit service-chip selection state) then evaluates click to bypass the
 * overflow:hidden sidebar that blocks Playwright's viewport-check in CI.
 */
export async function clickWalkinSubmit(page: Page): Promise<void> {
  // :not([disabled]) ensures React has committed the service selection before we click
  const loc = page.locator('[data-testid="walkin-submit"]:not([disabled])');
  await loc.waitFor({ state: "attached", timeout: 15_000 });
  await loc.evaluate((el: HTMLElement) => {
    el.click();
  });
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

  await page.context().addCookies([
    {
      name: "nailiq-demo-slug",
      value: slug,
      url: baseURL,
    },
  ]);

  // Default to EN locale before any page script runs — `useUserLanguage`
  // hydrates from localStorage `nailiq-user-lang`, and a leftover "vi"
  // value from a prior session would render the owner dashboard in
  // Vietnamese (e.g. "Hôm nay" instead of "Today"), breaking exact-match
  // `getByRole("region", { name: /^Today$/i })` assertions. Mirrors the
  // conditional default in `gotoReceptionistCenter` — only sets when
  // localStorage has no value, so locale-specific specs that opt in via
  // their own `addInitScript` are preserved.
  await page.addInitScript(() => {
    try {
      if (window.localStorage.getItem("nailiq-user-lang") == null) {
        window.localStorage.setItem("nailiq-user-lang", "en");
      }
    } catch {
      /* private mode / quota — ignore, hydration falls back to "en" */
    }
  });

  await page.goto(`/dashboard/${encodeURIComponent(slug)}`);
  await page.getByRole("heading", { name: /e2e receptionist center salon/i }).waitFor({
    timeout: 30_000,
  });
}
