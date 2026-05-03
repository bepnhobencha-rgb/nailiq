/**
 * Manual smoke — `create_public_booking` conflict path + salon-local opening hours (timezone-aware RPC).
 *
 * Loads `.env.local` (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + optional NAILIQ_SMOKE_*).
 * Temporarily merges Sunday hours (10:00–17:00, open) on the resolved salon for deterministic Sunday cases;
 * restores original `opening_hours` in `finally`.
 *
 * **Prerequisite:** Supabase must run **`create_public_booking` RPC v2.4** (migration
 * `supabase/migrations/20260503140000_create_public_booking_salon_timezone_hours.sql`).
 * Older RPCs interpret opening_hours as UTC wall-clock; this smoke picks salon-local slots and will see
 * `{ success: false, code: "outside_hours" }` on overlap/non-overlap steps until that migration is applied.
 *
 * Run: `npx tsx src/shared/dashboard/__tests__/publicBookingConflict.smoke.ts`
 */
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import {
  parseOpeningHours,
  type DayKey,
  type OpeningHoursWeek,
} from "@/shared/dashboard/openingHoursDefaults";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  salonDateOffset,
  salonWallTimeToUtcIso,
} from "@/shared/lib/salonTime";

const HARDCODED_DEV_SALON_ID = "";
const HARDCODED_DEV_SERVICE_ID = "";
const HARDCODED_DEV_STAFF_ID = "";

const RESOLVE_SLUG =
  process.env.NAILIQ_SMOKE_SLUG?.trim() || "nailiq-demo-slug";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function slotConflictOutcome(
  data: unknown,
  error: { message?: string; code?: string } | null,
) {
  if (error) {
    const m = String(error.message ?? "").toLowerCase();
    const c = String(error.code ?? "").toLowerCase();
    return (
      m.includes("slot_conflict") ||
      m.includes("exclusion") ||
      c === "23p01"
    );
  }
  if (
    data &&
    typeof data === "object" &&
    (data as { success?: boolean; code?: string }).success === false &&
    String((data as { code?: string }).code ?? "") === "slot_conflict"
  ) {
    return true;
  }
  return false;
}

function outsideHoursOutcome(data: unknown): boolean {
  return (
    data != null &&
    typeof data === "object" &&
    (data as { success?: boolean; code?: string }).success === false &&
    String((data as { code?: string }).code ?? "") === "outside_hours"
  );
}

function timeHmToMinuteOfDay(open: string): { hh: number; mm: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(open.trim());
  assert(m != null, "open HH:MM");
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  assert(Number.isFinite(hh) && Number.isFinite(mm), "hours parse");
  return { hh, mm };
}

/** Weekday short label in `timezone` at local noon on `ymd` (salon calendar day). */
function dayKeyFromSalonYmd(ymd: string, timezone: string): DayKey {
  const utcIso = salonWallTimeToUtcIso(ymd, 12 * 60, timezone);
  const w = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(new Date(utcIso));
  const map: Record<string, DayKey> = {
    Sun: "sun",
    Mon: "mon",
    Tue: "tue",
    Wed: "wed",
    Thu: "thu",
    Fri: "fri",
    Sat: "sat",
  };
  const k = map[w];
  assert(k != null, `unexpected weekday label "${w}"`);
  return k;
}

/** Next salon-local day (offset ≥ 1 from today) with an open window and slot ≥ minLeadMs ahead of now. */
function pickFutureOpenSlotSalonTz(opts: {
  timezone: string;
  week: OpeningHoursWeek;
  closed: ReadonlySet<string>;
  totalMinutes: number;
  minLeadMs: number;
  /** Minutes after local midnight for trial slot (default ~2h after open). */
  afterOpenMinutes?: number;
}): Date {
  const {
    timezone,
    week,
    closed,
    totalMinutes,
    minLeadMs,
    afterOpenMinutes,
  } = opts;

  const minStart = Date.now() + minLeadMs;

  for (let off = 1; off <= 56; off++) {
    const ymd = salonDateOffset(timezone, off);
    const key = dayKeyFromSalonYmd(ymd, timezone);
    const cfg = week[key];
    if (!cfg || cfg.closed) continue;
    if (closed.has(ymd)) continue;

    const oh = timeHmToMinuteOfDay(cfg.open);
    const ch = timeHmToMinuteOfDay(cfg.close);
    const openMo = oh.hh * 60 + oh.mm;
    const closeMo = ch.hh * 60 + ch.mm;
    if (closeMo <= openMo) continue;

    const trialMo =
      afterOpenMinutes != null ? openMo + afterOpenMinutes : openMo + 120;
    if (trialMo >= closeMo) continue;

    const iso = salonWallTimeToUtcIso(ymd, trialMo, timezone);
    const slot = new Date(iso);
    const slotEnd = slot.getTime() + totalMinutes * 60_000;
    const closeBoundary = new Date(
      salonWallTimeToUtcIso(ymd, closeMo, timezone),
    ).getTime();

    if (
      slot.getTime() >= minStart &&
      slotEnd <= closeBoundary &&
      slotEnd > slot.getTime()
    ) {
      return slot;
    }
  }
  throw new Error(
    "could not find an open salon-local day — widen hours or booking_closed_dates",
  );
}

/** Next Sunday `YYYY-MM-DD` in `timezone` where `localMinutesFromMidnight` is still ≥ now + lead. */
function nextFutureSundayYmd(opts: {
  timezone: string;
  localMinutesFromMidnight: number;
  leadMs: number;
}): string {
  const { timezone, localMinutesFromMidnight, leadMs } = opts;
  const need = Date.now() + leadMs;
  for (let off = 0; off <= 400; off++) {
    const ymd = salonDateOffset(timezone, off);
    if (dayKeyFromSalonYmd(ymd, timezone) !== "sun") continue;
    const startMs = new Date(
      salonWallTimeToUtcIso(ymd, localMinutesFromMidnight, timezone),
    ).getTime();
    if (startMs >= need) return ymd;
  }
  throw new Error("could not find a future Sunday for smoke");
}

function addUtcMinutes(d: Date, min: number): Date {
  return new Date(d.getTime() + min * 60_000);
}

async function resolveDevIds(supabase: ReturnType<typeof createServiceRoleClient>): Promise<{
  salonId: string;
  serviceId: string;
  staffId: string;
}> {
  const sa =
    process.env.NAILIQ_SMOKE_SALON_ID?.trim() || HARDCODED_DEV_SALON_ID.trim();
  const sv =
    process.env.NAILIQ_SMOKE_SERVICE_ID?.trim() ||
    HARDCODED_DEV_SERVICE_ID.trim();
  const st =
    process.env.NAILIQ_SMOKE_STAFF_ID?.trim() || HARDCODED_DEV_STAFF_ID.trim();

  if (sa && sv && st) {
    assert(UUID_RE.test(sa), "salon UUID invalid");
    assert(UUID_RE.test(sv), "service UUID invalid");
    assert(UUID_RE.test(st), "staff UUID invalid");
    return { salonId: sa, serviceId: sv, staffId: st };
  }

  const { data: slugSalon, error: se } = await supabase
    .from("salons")
    .select("id")
    .eq("slug", RESOLVE_SLUG)
    .maybeSingle();

  let salonRow = !se && slugSalon?.id ? slugSalon : null;

  if (!salonRow) {
    const { data: anySalon, error: anyErr } = await supabase
      .from("salons")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    assert(
      !anyErr && anySalon?.id,
      `resolve salon: set env or seed slug '${RESOLVE_SLUG}'`,
    );
    salonRow = anySalon;
  }

  const salonId = String(salonRow!.id);

  const { data: svc, error: sve } = await supabase
    .from("services")
    .select("id, duration_minutes")
    .eq("salon_id", salonId)
    .gte("duration_minutes", 1)
    .limit(1)
    .maybeSingle();

  assert(
    !sve && svc?.id && Number(svc.duration_minutes) >= 1,
    `resolve service: ${sve?.message ?? "need duration"}`,
  );

  const { data: staff, error: ste } = await supabase
    .from("staff")
    .select("id")
    .eq("salon_id", salonId)
    .limit(1)
    .maybeSingle();

  assert(!ste && staff?.id, `resolve staff: ${ste?.message ?? "need row"}`);

  return {
    salonId,
    serviceId: String(svc.id),
    staffId: String(staff.id),
  };
}

let pass = 0;

function PASS(name: string) {
  pass += 1;
  console.log(`PASS — ${name}`);
}

async function main() {
  const supabase = createServiceRoleClient();
  const { salonId, serviceId, staffId } = await resolveDevIds(supabase);

  const { data: salonRow } = await supabase
    .from("salons")
    .select("opening_hours, booking_closed_dates, timezone")
    .eq("id", salonId)
    .single();

  assert(salonRow, "salon meta");

  const timezone =
    String((salonRow as { timezone?: string }).timezone ?? "").trim() ||
    "America/Los_Angeles";

  const origHours = salonRow.opening_hours;
  const origBookingClosedDates = salonRow.booking_closed_dates;
  const baseWeek = parseOpeningHours(origHours);
  assert(baseWeek != null, "salon opening_hours invalid");

  const mergedWeek: OpeningHoursWeek = {
    ...baseWeek,
    sun: { open: "10:00", close: "17:00", closed: false },
  };

  const { error: patchErr } = await supabase
    .from("salons")
    .update({ opening_hours: mergedWeek })
    .eq("id", salonId);
  assert(!patchErr, `patch sunday hours: ${patchErr?.message ?? "?"}`);

  const closed = parseBookingClosedDateSet(
    (salonRow as { booking_closed_dates?: unknown }).booking_closed_dates,
  );

  const { data: svcRow } = await supabase
    .from("services")
    .select("duration_minutes, buffer_minutes")
    .eq("id", serviceId)
    .maybeSingle();

  const durMin = Number(svcRow?.duration_minutes ?? 45);
  const bufMin = Number(svcRow?.buffer_minutes ?? 0);
  const totalMin = durMin + bufMin;
  assert(totalMin >= 1, "service total minutes");

  const slotBase = pickFutureOpenSlotSalonTz({
    timezone,
    week: mergedWeek,
    closed,
    totalMinutes: totalMin,
    minLeadMs: 3 * 60 * 1000,
  });
  const blockStartIso = slotBase.toISOString();
  const blockEndIso = addUtcMinutes(slotBase, totalMin).toISOString();

  const blockerName = `TEST_PUBLIC_CONFLICT_${Date.now()}`;
  const bookingIdsToDelete: string[] = [];
  let blockerId: string | null = null;

  try {
    const { data: inserted, error: insErr } = await supabase
      .from("bookings")
      .insert({
        salon_id: salonId,
        service_id: serviceId,
        staff_id: staffId,
        client_name: blockerName,
        client_phone: "15551234567",
        start_time_utc: blockStartIso,
        end_time_utc: blockEndIso,
        status: "confirmed",
        source: "appointment",
        price_cents: svcRow?.duration_minutes != null ? 100 : null,
      })
      .select("id")
      .maybeSingle();

    assert(!insErr && inserted?.id, `seed booking: ${insErr?.message ?? "no row"}`);
    blockerId = String(inserted!.id);

    const rpcPayload = {
      p_salon_id: salonId,
      p_service_id: serviceId,
      p_staff_id: staffId,
      p_client_name: "Smoke Guest",
      p_client_phone: "15559876543",
      p_start_time_utc: blockStartIso,
      p_end_time_utc: blockEndIso,
      p_status: "pending",
      p_price_cents: 100,
      p_client_notes: null,
      p_addon_service_id: null,
      p_addon_price_cents: null,
    };

    PASS("seed — blocking appointment inserted for overlap window");

    const { data, error } = await supabase.rpc("create_public_booking", rpcPayload);
    assert(
      slotConflictOutcome(data, error),
      `overlap: expected slot_conflict; data=${JSON.stringify(data)} err=${error?.message}`,
    );
    PASS("overlap — create_public_booking rejects slot_conflict");

    const freeStart = addUtcMinutes(slotBase, totalMin + 30);
    const freeEnd = addUtcMinutes(freeStart, totalMin);

    assert(
      freeStart.getTime() < freeEnd.getTime(),
      "non-overlap window invalid",
    );

    {
      const r2 = await supabase.rpc("create_public_booking", {
        ...rpcPayload,
        p_start_time_utc: freeStart.toISOString(),
        p_end_time_utc: freeEnd.toISOString(),
        p_client_phone: "15554443322",
      });
      assert(
        !r2.error,
        `free slot: RPC error ${r2.error?.message ?? "?"} JSON ${JSON.stringify(r2.data)}`,
      );
      assert(
        r2.data &&
          typeof r2.data === "object" &&
          (r2.data as { success?: boolean }).success === true &&
          typeof (r2.data as { booking_id?: string }).booking_id === "string",
        `free slot: bad JSON ${JSON.stringify(r2.data)}`,
      );
      const okId = (r2.data as { booking_id: string }).booking_id;
      bookingIdsToDelete.push(okId);
    }
    PASS("non-overlap — RPC succeeds");

    await supabase.from("bookings").delete().eq("id", blockerId);
    blockerId = null;

    // --- Sunday + edge cases (salon-local wall clock via salons.timezone) ---
    const sunOpenMo = 10 * 60;
    const sunCloseMo = 17 * 60;
    assert(
      sunCloseMo - sunOpenMo >= totalMin,
      `smoke: service block ${totalMin}m longer than Sunday 10–17 window`,
    );

    const leadMs = 3 * 60 * 1000;
    const sunYmd = nextFutureSundayYmd({
      timezone,
      localMinutesFromMidnight: 15 * 60,
      leadMs,
    });

    assert(
      15 * 60 + totalMin <= sunCloseMo,
      "smoke: 15:00 Sunday start + service exceeds merged Sunday close",
    );

    const sundayStart15 = new Date(
      salonWallTimeToUtcIso(sunYmd, 15 * 60, timezone),
    );
    const sundayEnd15 = addUtcMinutes(sundayStart15, totalMin);
    {
      const r = await supabase.rpc("create_public_booking", {
        ...rpcPayload,
        p_start_time_utc: sundayStart15.toISOString(),
        p_end_time_utc: sundayEnd15.toISOString(),
        p_client_phone: "15551110001",
      });
      assert(!r.error, `Sunday 3pm: ${r.error?.message}`);
      assert(
        r.data &&
          typeof r.data === "object" &&
          (r.data as { success?: boolean }).success === true,
        JSON.stringify(r.data),
      );
      bookingIdsToDelete.push((r.data as { booking_id: string }).booking_id);
    }
    PASS("Sunday 15:00 local — success");

    assert(
      16 * 60 + totalMin <= sunCloseMo,
      "smoke: 16:00 Sunday start + service exceeds merged Sunday close",
    );

    const sundayStart16 = new Date(
      salonWallTimeToUtcIso(sunYmd, 16 * 60, timezone),
    );
    const sundayEnd16 = addUtcMinutes(sundayStart16, totalMin);
    {
      const r = await supabase.rpc("create_public_booking", {
        ...rpcPayload,
        p_start_time_utc: sundayStart16.toISOString(),
        p_end_time_utc: sundayEnd16.toISOString(),
        p_client_phone: "15551110002",
      });
      assert(!r.error, `Sunday 4pm: ${r.error?.message}`);
      assert(
        r.data &&
          typeof r.data === "object" &&
          (r.data as { success?: boolean }).success === true,
        JSON.stringify(r.data),
      );
      bookingIdsToDelete.push((r.data as { booking_id: string }).booking_id);
    }
    PASS("Sunday 16:00 local — success");

    const sunday1630 = new Date(
      salonWallTimeToUtcIso(sunYmd, 16 * 60 + 30, timezone),
    );
    const sunday1630End = addUtcMinutes(sunday1630, 60);
    {
      const r = await supabase.rpc("create_public_booking", {
        ...rpcPayload,
        p_start_time_utc: sunday1630.toISOString(),
        p_end_time_utc: sunday1630End.toISOString(),
        p_client_phone: "15551110003",
      });
      assert(!r.error, `Sunday overrun should return JSON: ${r.error?.message}`);
      assert(outsideHoursOutcome(r.data), JSON.stringify(r.data));
    }
    PASS("Sunday 16:30 + 60m — outside_hours");

    const sunOpenYmd = nextFutureSundayYmd({
      timezone,
      localMinutesFromMidnight: 10 * 60,
      leadMs,
    });
    const exactOpenStart = new Date(
      salonWallTimeToUtcIso(sunOpenYmd, 10 * 60, timezone),
    );
    const exactOpenEnd = addUtcMinutes(exactOpenStart, Math.min(30, totalMin));
    {
      const r = await supabase.rpc("create_public_booking", {
        ...rpcPayload,
        p_start_time_utc: exactOpenStart.toISOString(),
        p_end_time_utc: exactOpenEnd.toISOString(),
        p_client_phone: "15551110004",
      });
      assert(!r.error, `exact open: ${r.error?.message}`);
      assert(
        r.data &&
          typeof r.data === "object" &&
          (r.data as { success?: boolean }).success === true,
        JSON.stringify(r.data),
      );
      bookingIdsToDelete.push((r.data as { booking_id: string }).booking_id);
    }
    PASS("Sunday exact local open — success");

    const sunCloseYmd = nextFutureSundayYmd({
      timezone,
      localMinutesFromMidnight: 12 * 60,
      leadMs,
    });
    const exactCloseStartMinute = sunCloseMo - totalMin;
    assert(
      exactCloseStartMinute >= sunOpenMo,
      "smoke: cannot place block ending exactly at Sunday close with this service length",
    );
    const exactCloseStart = new Date(
      salonWallTimeToUtcIso(sunCloseYmd, exactCloseStartMinute, timezone),
    );
    const exactCloseEnd = addUtcMinutes(exactCloseStart, totalMin);
    {
      const r = await supabase.rpc("create_public_booking", {
        ...rpcPayload,
        p_start_time_utc: exactCloseStart.toISOString(),
        p_end_time_utc: exactCloseEnd.toISOString(),
        p_client_phone: "15551110005",
      });
      assert(!r.error, `exact close end: ${r.error?.message}`);
      assert(
        r.data &&
          typeof r.data === "object" &&
          (r.data as { success?: boolean }).success === true,
        JSON.stringify(r.data),
      );
      bookingIdsToDelete.push((r.data as { booking_id: string }).booking_id);
    }
    PASS("Sunday block ending exactly at local close — success");

    // Salon-local closed_dates: same calendar day in timezone must reject (v2.4).
    const closedSunYmd = nextFutureSundayYmd({
      timezone,
      localMinutesFromMidnight: 12 * 60,
      leadMs,
    });
    const prevClosed: unknown[] = Array.isArray(origBookingClosedDates)
      ? [...origBookingClosedDates]
      : [];
    if (!prevClosed.includes(closedSunYmd)) prevClosed.push(closedSunYmd);
    const { error: closedPatchErr } = await supabase
      .from("salons")
      .update({ booking_closed_dates: prevClosed })
      .eq("id", salonId);
    assert(!closedPatchErr, `patch closed dates: ${closedPatchErr?.message ?? "?"}`);

    const sundayStart12 = new Date(
      salonWallTimeToUtcIso(closedSunYmd, 12 * 60, timezone),
    );
    const sundayEnd12 = addUtcMinutes(sundayStart12, totalMin);
    assert(
      12 * 60 + totalMin <= sunCloseMo,
      "smoke: 12:00 Sunday start + service exceeds merged Sunday close",
    );
    {
      const r = await supabase.rpc("create_public_booking", {
        ...rpcPayload,
        p_start_time_utc: sundayStart12.toISOString(),
        p_end_time_utc: sundayEnd12.toISOString(),
        p_client_phone: "15551110006",
      });
      assert(!r.error, `closed date: ${r.error?.message}`);
      assert(outsideHoursOutcome(r.data), JSON.stringify(r.data));
    }
    PASS("Sunday salon-local closed date — outside_hours");

    assert(pass === 9, `expected 9 PASS lines, got ${pass}`);
  } finally {
    if (blockerId) {
      await supabase.from("bookings").delete().eq("id", blockerId);
    }
    await supabase
      .from("salons")
      .update({
        opening_hours: origHours,
        booking_closed_dates: origBookingClosedDates,
      })
      .eq("id", salonId);
    if (bookingIdsToDelete.length > 0) {
      await supabase.from("bookings").delete().in("id", bookingIdsToDelete);
    }
    console.log("Cleanup: salon hours restored; smoke bookings deleted");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
