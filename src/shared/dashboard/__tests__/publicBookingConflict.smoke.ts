/**
 * Manual smoke — `create_public_booking` conflict path vs seeded appointment row (same staff/time).
 *
 * Loads `.env.local` (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + optional NAILIQ_SMOKE_*).
 * Mirrors ID resolution pattern from `receptionistActions.smoke.ts`.
 *
 * Run: `npx tsx src/shared/dashboard/__tests__/publicBookingConflict.smoke.ts`
 */
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import { parseOpeningHours, type DayKey } from "@/shared/dashboard/openingHoursDefaults";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const KEY_FROM_SUN0: readonly DayKey[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;

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

function utcYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcAt(
  y: number,
  mo: number,
  day: number,
  hh: number,
  mm: number,
): Date {
  return new Date(Date.UTC(y, mo - 1, day, hh, mm, 0, 0));
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

function timeHmToMinuteOfDay(open: string): { hh: number; mm: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(open.trim());
  assert(m != null, "open HH:MM");
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  assert(Number.isFinite(hh) && Number.isFinite(mm), "hours parse");
  return { hh, mm };
}

/** Next UTC calendar day with a trial start (~2h after open) satisfying RPC lead time + salon hours (UTC wall clock). */
function pickOpenDayStartUtc(openingHoursRaw: unknown, closedRaw: unknown): Date {
  const week = parseOpeningHours(openingHoursRaw);
  assert(week != null, "salon opening_hours invalid");
  const closed = parseBookingClosedDateSet(closedRaw);

  const minStart = Date.now() + 3 * 60 * 1000;
  const baseUtc = new Date();
  const y = baseUtc.getUTCFullYear();
  const mo = baseUtc.getUTCMonth();
  const day = baseUtc.getUTCDate();

  for (let off = 1; off <= 56; off++) {
    const probe = new Date(Date.UTC(y, mo, day + off, 0, 0, 0, 0));
    const key = KEY_FROM_SUN0[probe.getUTCDay()];
    const cfg = week[key];
    if (!cfg || cfg.closed) continue;
    const ymdProbe = utcYmd(probe);
    if (closed.has(ymdProbe)) continue;

    const oh = timeHmToMinuteOfDay(cfg.open);
    const ch = timeHmToMinuteOfDay(cfg.close);
    const openMo = oh.hh * 60 + oh.mm + 120; // UTC wall-clock: start ~2h after open
    const closeMo = ch.hh * 60 + ch.mm;
    if (openMo >= closeMo) continue;

    const slot = utcAt(
      probe.getUTCFullYear(),
      probe.getUTCMonth() + 1,
      probe.getUTCDate(),
      Math.floor(openMo / 60),
      openMo % 60,
    );

    const openDt = utcAt(
      probe.getUTCFullYear(),
      probe.getUTCMonth() + 1,
      probe.getUTCDate(),
      oh.hh,
      oh.mm,
    );
    const closeDt = utcAt(
      probe.getUTCFullYear(),
      probe.getUTCMonth() + 1,
      probe.getUTCDate(),
      ch.hh,
      ch.mm,
    );

    const t = slot.getTime();
    if (
      t < Math.max(openDt.getTime(), minStart) ||
      t >= closeDt.getTime()
    ) {
      continue;
    }
    return slot;
  }
  throw new Error(
    "could not find an open UTC day for slot picker — fix salon opening_hours/holidays",
  );
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
    .select("opening_hours, booking_closed_dates")
    .eq("id", salonId)
    .single();

  assert(salonRow, "salon meta");

  const { data: svcRow } = await supabase
    .from("services")
    .select("duration_minutes, buffer_minutes")
    .eq("id", serviceId)
    .maybeSingle();

  const durMin = Number(svcRow?.duration_minutes ?? 45);
  const bufMin = Number(svcRow?.buffer_minutes ?? 0);
  const totalMin = durMin + bufMin;
  assert(totalMin >= 1, "service total minutes");

  const slotBase = pickOpenDayStartUtc(
    salonRow.opening_hours,
    (salonRow as { booking_closed_dates?: unknown }).booking_closed_dates,
  );
  const blockStartIso = slotBase.toISOString();
  const blockEndIso = addUtcMinutes(slotBase, totalMin).toISOString();

  const blockerName = `TEST_PUBLIC_CONFLICT_${Date.now()}`;
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
  const blockerId = String(inserted!.id);

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

  try {
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
      await supabase.from("bookings").delete().eq("id", okId);
    }
    PASS("non-overlap — RPC succeeds");

    assert(pass === 3, `expected 3 PASS lines, got ${pass}`);
  } finally {
    await supabase.from("bookings").delete().eq("id", blockerId);
    console.log("Cleanup: blocker booking deleted");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
