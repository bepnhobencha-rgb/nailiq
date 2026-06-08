/**
 * Group-booking E2E shared helpers.
 *
 * Standard `seedTestSalon` ships a 1-staff / 1-service salon, which
 * is *insufficient* for group booking — the flow caps at
 * `min(activeStaffCount, 6)` and hides the toggle entirely below 2.
 * Specs here use `seedGroupTestSalon` which adds 2 more staff + 2
 * more services on top of the standard seed so the group toggle is
 * visible and the scheduler can find non-overlapping arrangements.
 */
import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { seedTestSalon } from "../helpers/db";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl?.trim() || !serviceKey?.trim()) {
  throw new Error(
    "e2e/group-booking/helpers requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
  );
}
const supabase = createClient(supabaseUrl, serviceKey);

export type GroupTestSalon = {
  slug: string;
  salonId: string;
  staffIds: string[];
  serviceIds: string[];
};

/**
 * Seed a salon with 3 staff + 3 services (each staff capable of
 * every service). The default DB opening_hours (mon-sat 09-18,
 * sun closed) is left untouched.
 */
export async function seedGroupTestSalon(
  slug = "e2e-group-booking",
): Promise<GroupTestSalon> {
  const { salonId } = await seedTestSalon({
    slug,
    name: "E2E Group Salon",
    phone: "15557776666",
    // PR2: group_booking is a Beta release flag (default OFF). Enable it so the
    // public Individual/Group toggle renders for these specs.
    feature_flags: { group_booking_enabled: true },
  });

  // Standard seed inserted 1 staff (Jenny) + 1 service (Gel Manicure).
  // Add two more of each so size 2 + 3 + various staff combinations
  // are testable.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { data: _extraStaff, error: staffErr } = await supabase
    .from("staff")
    .insert([
      { salon_id: salonId, name: "Linda", job_role: "nail_tech" },
      { salon_id: salonId, name: "Mai", job_role: "nail_tech" },
    ])
    .select("id");
  if (staffErr) throw new Error(`seedGroupTestSalon staff: ${staffErr.message}`);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { data: _extraSvc, error: svcErr } = await supabase
    .from("services")
    .insert([
      {
        salon_id: salonId,
        name: "Classic Pedicure",
        price_cents: 4000,
        duration_minutes: 45,
        buffer_minutes: 5,
      },
      {
        salon_id: salonId,
        name: "Acrylic Full Set",
        price_cents: 6500,
        duration_minutes: 60,
        buffer_minutes: 10,
      },
    ])
    .select("id");
  if (svcErr) throw new Error(`seedGroupTestSalon services: ${svcErr.message}`);

  // Pull all staff + services for the salon (existing + extras) and
  // cross-product the capability matrix so every staff can do every
  // service. Mirrors what `seedTestSalon` does for the standard
  // salon — keeps group flow + individual flow on the same gate.
  const { data: allStaff } = await supabase
    .from("staff")
    .select("id")
    .eq("salon_id", salonId);
  const { data: allSvc } = await supabase
    .from("services")
    .select("id")
    .eq("salon_id", salonId);

  const staffIds = (allStaff ?? []).map((s) => String(s.id));
  const serviceIds = (allSvc ?? []).map((s) => String(s.id));

  // staff_services has UNIQUE(staff_id, service_id); insert only the
  // pairs we just added so we don't double-insert the Jenny x Gel row.
  const existingPairs = new Set<string>();
  const { data: capRows } = await supabase
    .from("staff_services")
    .select("staff_id, service_id")
    .in("staff_id", staffIds);
  for (const r of capRows ?? []) {
    existingPairs.add(`${String(r.staff_id)}|${String(r.service_id)}`);
  }
  const missingPairs = [];
  for (const staff_id of staffIds) {
    for (const service_id of serviceIds) {
      if (!existingPairs.has(`${staff_id}|${service_id}`)) {
        missingPairs.push({ staff_id, service_id });
      }
    }
  }
  if (missingPairs.length > 0) {
    const { error: capErr } = await supabase
      .from("staff_services")
      .insert(missingPairs);
    if (capErr) throw new Error(`seedGroupTestSalon capability: ${capErr.message}`);
  }

  return { slug, salonId, staffIds, serviceIds };
}

// ─── Date helpers (salon-local in `America/Los_Angeles`) ─────────

const SALON_TZ = "America/Los_Angeles";

/** YYYY-MM-DD in the salon timezone offset by N days from "now". */
export function ymdInSalonTz(offsetDays: number): string {
  const target = new Date(Date.now() + offsetDays * 86400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SALON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(target);
}

/** Day-of-week (0=Sun..6=Sat) for a YMD treated as UTC midnight.
 *  The YMD is already in the salon tz, so UTC arithmetic on it
 *  returns the correct weekday. */
function dowForYmd(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Returns a future YMD that is **not** a Sunday — group flow needs
 *  an open day to generate arrangements. */
export function nextOpenDateYmd(minOffsetDays = 2): string {
  for (let i = minOffsetDays; i < minOffsetDays + 7; i++) {
    const ymd = ymdInSalonTz(i);
    if (dowForYmd(ymd) !== 0) return ymd;
  }
  throw new Error("nextOpenDateYmd: no non-Sunday date in range");
}

/** Pick a Sunday within the next 7 days to test the closed-day
 *  banner. */
export function nextSundayYmd(): string {
  for (let i = 1; i < 14; i++) {
    const ymd = ymdInSalonTz(i);
    if (dowForYmd(ymd) === 0) return ymd;
  }
  throw new Error("nextSundayYmd: no Sunday in range");
}

// ─── Page interaction helpers ────────────────────────────────────

/** Land on the group booking entry. The default booking language
 *  resolution with Playwright's default `en-US` accept-language
 *  returns EN, so the toggle text is "Group 👥". Click via testid
 *  so the spec stays locale-agnostic. */
/** Phone-first gate uses this throwaway number so the Individual/Group
 *  choice appears. Kept profile-less (deleted below) so recognition never
 *  auto-fills member names — tests that need a returning customer set
 *  their own phone later. */
export const GATE_PHONE_DIGITS = "16045550000";

export async function gotoGroupFlow(page: Page, slug: string): Promise<void> {
  // Keep the gate phone a NEW customer so Guest names stay default.
  await supabase.from("client_profiles").delete().eq("phone", GATE_PHONE_DIGITS);
  await page.goto(`/${slug}`);
  // Phone-first gate: a phone must be entered before the choice appears.
  await page
    .getByTestId("booking-entry-phone")
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("booking-entry-phone").fill(`+${GATE_PHONE_DIGITS}`);
  await page
    .getByTestId("booking-type-group")
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("booking-type-group").click();
  await page
    .getByTestId("group-step-size-panel")
    .waitFor({ state: "visible", timeout: 10_000 });
}

/** Fill a single member card. `staffIndex` is the 1-based position
 *  into the staff dropdown's non-empty options (so 1 = first staff,
 *  2 = second staff). `0` = "Any available". */
export async function fillMemberCard(
  page: Page,
  index: number,
  name: string,
  serviceOptionIndex = 1,
  staffOptionIndex = 1,
): Promise<void> {
  await page.getByTestId(`group-member-${index}-name`).fill(name);
  // Service select: index 0 is "— Services —" placeholder.
  await page
    .getByTestId(`group-member-${index}-service`)
    .selectOption({ index: serviceOptionIndex });
  // Staff select: index 0 is "— Any available staff —".
  await page
    .getByTestId(`group-member-${index}-staff`)
    .selectOption({ index: staffOptionIndex });
}

/**
 * Click a calendar cell for the target YMD in the group flow's
 * step-3 date picker (the visual calendar that replaced the native
 * `<input type="date">` in 2026-05-12). Each cell carries
 * `data-ymd="YYYY-MM-DD"` for direct selection. Navigates forward
 * up to 12 months if the target isn't in the currently-displayed
 * month.
 */
export async function pickDateInCalendar(
  page: Page,
  ymd: string,
): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const cell = page.locator(`[data-ymd="${ymd}"]`);
    if ((await cell.count()) > 0) {
      // `evaluate` dispatches the click directly to the DOM element,
      // bypassing the Next.js dev-overlay portal that sits on top at
      // desktop viewport widths and intercepts coordinate-based clicks
      // (including `force: true`). The native click() bubbles through
      // React's delegated event system and triggers onClick normally.
      await cell.first().evaluate((el) => (el as HTMLButtonElement).click());
      return;
    }
    await page.getByTestId("calendar-next-month").click();
  }
  throw new Error(`pickDateInCalendar: YMD ${ymd} not reachable`);
}
