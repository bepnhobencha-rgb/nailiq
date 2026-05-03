/**
 * Manual smoke — exercises the same mutations as `receptionistActions.ts` against Supabase,
 * bypassing `"use server"` / Next cookies (`getDashboardWriteClient` is unavailable in plain Node).
 *
 * Load env from `.env.local` (SERVICE_ROLE_URL + SERVICE_ROLE_KEY), then runs 12 CASES.
 *
 * Hardcoded IDs: paste UUIDs from your dev Supabase (Table Editor) OR leave empty strings
 * and set `NEXT_PUBLIC_SITE_URL`/slug resolution via `.env`:
 * overrides `NAILIQ_SMOKE_SALON_ID`, `NAILIQ_SMOKE_SERVICE_ID`, `NAILIQ_SMOKE_STAFF_ID`
 * optional; slug lookup uses `NAILIQ_SMOKE_SLUG` (default `nailiq-demo-slug`).
 *
 * Run: `npx tsx src/shared/dashboard/__tests__/receptionistActions.smoke.ts`
 */
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

import { createServiceRoleClient } from "../../lib/supabase/serviceRole";
import {
  ConflictCheckBooking,
  checkBookingConflict,
} from "../../lib/conflictCheck";
import { cleanPhone } from "../../lib/phoneFormat";
import type { BookingStatus } from "../../types";

/** Paste dev sandbox UUIDs — or rely on slug resolution + `.env.local` overrides. */
const HARDCODED_DEV_SALON_ID = "";
const HARDCODED_DEV_SERVICE_ID = "";
const HARDCODED_DEV_STAFF_ID = "";

const RESOLVE_SLUG = process.env.NAILIQ_SMOKE_SLUG?.trim() || "nailiq-demo-slug";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function resolveDevIds(supabase: ReturnType<typeof createServiceRoleClient>): Promise<{
  salonId: string;
  serviceId: string;
  staffId: string;
}> {
  const sa =
    process.env.NAILIQ_SMOKE_SALON_ID?.trim() || HARDCODED_DEV_SALON_ID.trim();
  const sv =
    process.env.NAILIQ_SMOKE_SERVICE_ID?.trim() || HARDCODED_DEV_SERVICE_ID.trim();
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
    if (anyErr || !anySalon?.id) {
      salonRow = null;
    } else {
      console.warn(
        `[smoke] slug '${RESOLVE_SLUG}' not found — using earliest salon row. Pin tenant with env NAILIQ_SMOKE_SALON_ID (and service/staff) or paste HARDCODED_* in this file.`,
      );
      salonRow = anySalon;
    }
  }

  assert(
    salonRow?.id,
    `resolve salon: set HARDCODED_* or env NAILIQ_SMOKE_SALON_ID (+ service/staff), or seed slug '${RESOLVE_SLUG}'. Slug error: ${se?.message ?? "none"}`,
  );

  const salonId = String(salonRow.id);

  const { data: svc, error: sve } = await supabase
    .from("services")
    .select("id, duration_minutes")
    .eq("salon_id", salonId)
    .gte("duration_minutes", 1)
    .limit(1)
    .maybeSingle();

  assert(
    !sve && svc?.id && Number(svc.duration_minutes) >= 1,
    `resolve service: ${sve?.message ?? "need one service with duration_minutes >= 1"}`,
  );

  const { data: staff, error: ste } = await supabase
    .from("staff")
    .select("id")
    .eq("salon_id", salonId)
    .limit(1)
    .maybeSingle();

  assert(!ste && staff?.id, `resolve staff: ${ste?.message ?? "need one staff row"}`);

  return { salonId, serviceId: String(svc.id), staffId: String(staff.id) };
}

// --- Mirrors `receptionistActions.ts` (service-role client; no salon slug/auth layer) ---

type Fail = { ok: false; error: string };

function fail(error: string): Fail {
  return { ok: false, error };
}

async function smokeAddWalkinToQueue(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  serviceId: string,
): Promise<{ ok: true; bookingId: string } | Fail> {
  const { data: svc, error: svcErr } = await supabase
    .from("services")
    .select("id, price_cents")
    .eq("id", serviceId)
    .eq("salon_id", salonId)
    .maybeSingle();

  if (svcErr) return fail("server_error");
  if (!svc?.id) return fail("service_not_found");

  const joinedAt = new Date().toISOString();
  const price = svc.price_cents != null ? Math.round(Number(svc.price_cents)) : null;

  const phone = cleanPhone("5550199001");
  const clientPhoneClean = phone.length > 0 ? phone : null;

  const { data: inserted, error: insErr } = await supabase
    .from("bookings")
    .insert({
      salon_id: salonId,
      service_id: serviceId,
      client_name: `Smoke Receptionist ${Date.now()}`,
      client_phone: clientPhoneClean,
      client_notes: null,
      staff_id: null,
      start_time_utc: null,
      end_time_utc: null,
      status: "waiting",
      source: "walkin",
      joined_queue_at: joinedAt,
      staff_request_note: null,
      price_cents: Number.isFinite(price ?? NaN) ? price : null,
    })
    .select("id")
    .maybeSingle();

  if (insErr) return fail("server_error");
  const bid = inserted && "id" in inserted ? String(inserted.id) : "";
  if (!bid) return fail("server_error");
  return { ok: true, bookingId: bid };
}

async function smokeAssignWalkinToSlot(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  bookingId: string,
  staffId: string,
  slotStartUtc: string,
): Promise<{ ok: true } | Fail> {
  const bookingIdTrim = bookingId.trim();
  const staffIdTrim = staffId.trim();
  if (!bookingIdTrim || !UUID_RE.test(bookingIdTrim)) return fail("invalid_booking");
  if (!staffIdTrim || !UUID_RE.test(staffIdTrim)) return fail("invalid_staff");

  const startMs = Date.parse(slotStartUtc);
  if (Number.isNaN(startMs)) return fail("invalid_time");

  const { data: staffRow } = await supabase
    .from("staff")
    .select("id")
    .eq("id", staffIdTrim)
    .eq("salon_id", salonId)
    .maybeSingle();

  if (!staffRow?.id) return fail("staff_not_found");

  const { data: booking, error: bkErr } = await supabase
    .from("bookings")
    .select(
      `
      id,
      salon_id,
      status,
      source,
      service_id,
      services!bookings_service_id_fkey ( duration_minutes, buffer_minutes )
    `,
    )
    .eq("id", bookingIdTrim)
    .eq("salon_id", salonId)
    .maybeSingle();

  if (bkErr) return fail("server_error");
  if (
    !booking?.id ||
    String(booking.source) !== "walkin" ||
    String(booking.status) !== "waiting"
  ) {
    return fail("invalid_state");
  }

  type SvcDur = {
    duration_minutes?: unknown;
    buffer_minutes?: unknown;
  };
  const join = booking.services as SvcDur | SvcDur[] | null | undefined;
  const serviceRow = Array.isArray(join) ? join[0] : join;
  const duration = Math.round(Number(serviceRow?.duration_minutes ?? 0));
  const buffer = Math.round(Number(serviceRow?.buffer_minutes ?? 0));
  if (!Number.isFinite(duration) || duration < 1) return fail("invalid_duration");
  if (!Number.isFinite(buffer) || buffer < 0) return fail("invalid_buffer");

  const totalMin = duration + buffer;
  const endMs = startMs + totalMin * 60 * 1000;
  const slotEndUtc = new Date(endMs).toISOString();

  const { data: existing, error: exErr } = await supabase
    .from("bookings")
    .select("id, staff_id, start_time_utc, end_time_utc, status, client_name")
    .eq("salon_id", salonId)
    .eq("staff_id", staffIdTrim)
    .in("status", ["pending", "confirmed", "in_progress", "completed"]);

  if (exErr) return fail("server_error");

  const conflict = checkBookingConflict({
    staffId: staffIdTrim,
    startUtcIso: slotStartUtc,
    endUtcIso: slotEndUtc,
    existingBookings: (existing ?? []) as ConflictCheckBooking[],
  });
  if (conflict !== null) return fail("slot_conflict");

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({
      staff_id: staffIdTrim,
      start_time_utc: slotStartUtc,
      end_time_utc: slotEndUtc,
      status: "confirmed",
    })
    .eq("id", bookingIdTrim)
    .eq("salon_id", salonId)
    .eq("source", "walkin")
    .eq("status", "waiting")
    .select("id")
    .maybeSingle();

  if (upErr) return fail("server_error");
  if (!updated?.id) return fail("lost_race");
  return { ok: true };
}

async function smokeCancelWaitingWalkin(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  bookingId: string,
): Promise<{ ok: true } | Fail> {
  const bookingIdTrim = bookingId.trim();
  if (!UUID_RE.test(bookingIdTrim)) return fail("invalid_booking");

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingIdTrim)
    .eq("salon_id", salonId)
    .eq("source", "walkin")
    .eq("status", "waiting")
    .select("id")
    .maybeSingle();

  if (upErr) return fail("server_error");
  if (!updated?.id) return fail("invalid_state");
  return { ok: true };
}

async function smokeUndoWalkinAssignment(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  bookingId: string,
): Promise<{ ok: true } | Fail> {
  const bookingIdTrim = bookingId.trim();
  if (!UUID_RE.test(bookingIdTrim)) return fail("invalid_booking");

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({
      status: "waiting",
      staff_id: null,
      start_time_utc: null,
      end_time_utc: null,
    })
    .eq("id", bookingIdTrim)
    .eq("salon_id", salonId)
    .eq("source", "walkin")
    .eq("status", "confirmed")
    .select("id")
    .maybeSingle();

  if (upErr) return fail("server_error");
  if (!updated?.id) return fail("already_started");
  return { ok: true };
}

/** Mirrors `salonOwnerActions.updateBookingStatus` (service-role; same transition matrix + optimistic `status` guard). */
async function smokeMirrorUpdateBookingStatus(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  bookingId: string,
  nextStatus: BookingStatus,
): Promise<{ ok: true } | Fail> {
  const bookingIdTrim = bookingId.trim();
  if (!bookingIdTrim || !UUID_RE.test(bookingIdTrim)) return fail("invalid_booking");

  const { data: row, error: fetchErr } = await supabase
    .from("bookings")
    .select("id, status, salon_id")
    .eq("id", bookingIdTrim)
    .maybeSingle();

  if (fetchErr || !row || String(row.salon_id) !== salonId) {
    return fail("not_found");
  }

  const cur = String(row.status) as BookingStatus;
  const toInProgress =
    nextStatus === "in_progress" &&
    (cur === "pending" || cur === "confirmed");

  const allowed =
    (cur === "pending" && nextStatus === "confirmed") ||
    (cur === "confirmed" && nextStatus === "completed") ||
    (cur === "in_progress" && nextStatus === "completed") ||
    toInProgress;

  if (!allowed) {
    return fail("invalid_transition");
  }

  const startedAt = new Date().toISOString();
  const patch: { status: BookingStatus; started_at?: string | null } = toInProgress
    ? { status: "in_progress", started_at: startedAt }
    : { status: nextStatus };

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update(patch)
    .eq("id", bookingIdTrim)
    .eq("salon_id", salonId)
    .eq("status", cur)
    .select("id")
    .maybeSingle();

  if (upErr) return fail("server_error");
  if (!updated?.id) return fail("invalid_transition");
  return { ok: true };
}

/** Mirrors `receptionistActions.cancelDeskBooking`. */
async function smokeMirrorCancelDeskBooking(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  bookingId: string,
): Promise<{ ok: true } | Fail> {
  const bookingIdTrim = bookingId.trim();
  if (!bookingIdTrim || !UUID_RE.test(bookingIdTrim)) return fail("invalid_booking");

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingIdTrim)
    .eq("salon_id", salonId)
    .in("status", ["pending", "confirmed", "in_progress"])
    .select("id")
    .maybeSingle();

  if (upErr) return fail("server_error");
  if (!updated?.id) return fail("invalid_state");
  return { ok: true };
}

async function smokeInsertAppointmentBooking(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  serviceId: string,
  staffId: string,
  slotStartUtc: string,
  status: "pending" | "confirmed",
): Promise<{ ok: true; bookingId: string } | Fail> {
  const startMs = Date.parse(slotStartUtc);
  if (Number.isNaN(startMs)) return fail("invalid_time");

  const { data: svc, error: svcErr } = await supabase
    .from("services")
    .select("id, duration_minutes, buffer_minutes, price_cents")
    .eq("id", serviceId)
    .eq("salon_id", salonId)
    .maybeSingle();

  if (svcErr) return fail("server_error");
  if (!svc?.id) return fail("service_not_found");

  const duration = Math.round(Number(svc.duration_minutes ?? 0));
  const buffer = Math.round(Number(svc.buffer_minutes ?? 0));
  if (!Number.isFinite(duration) || duration < 1) return fail("invalid_duration");
  if (!Number.isFinite(buffer) || buffer < 0) return fail("invalid_buffer");

  const totalMin = duration + buffer;
  const endMs = startMs + totalMin * 60 * 1000;
  const slotEndUtc = new Date(endMs).toISOString();

  const price = svc.price_cents != null ? Math.round(Number(svc.price_cents)) : null;

  const { data: inserted, error: insErr } = await supabase
    .from("bookings")
    .insert({
      salon_id: salonId,
      service_id: serviceId,
      client_name: `Smoke Appt ${Date.now()}`,
      client_phone: null,
      client_notes: null,
      staff_id: staffId,
      start_time_utc: slotStartUtc,
      end_time_utc: slotEndUtc,
      status,
      source: "appointment",
      joined_queue_at: null,
      staff_request_note: null,
      price_cents: Number.isFinite(price ?? NaN) ? price : null,
    })
    .select("id")
    .maybeSingle();

  if (insErr) return fail("server_error");
  const bid = inserted && "id" in inserted ? String(inserted.id) : "";
  if (!bid) return fail("server_error");
  return { ok: true, bookingId: bid };
}

async function smokeMarkWalkinInProgress(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  bookingId: string,
): Promise<{ ok: true } | Fail> {
  const bookingIdTrim = bookingId.trim();
  if (!UUID_RE.test(bookingIdTrim)) return fail("invalid_booking");

  const startedAt = new Date().toISOString();

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({
      status: "in_progress",
      started_at: startedAt,
    })
    .eq("id", bookingIdTrim)
    .eq("salon_id", salonId)
    .eq("source", "walkin")
    .eq("status", "confirmed")
    .select("id")
    .maybeSingle();

  if (upErr) return fail("server_error");
  if (!updated?.id) return fail("invalid_state");
  return { ok: true };
}

// --- Harness ---

let pass = 0;
let failed = 0;

async function smoke(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(e);
  }
}

async function main() {
  assert(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(),
    "Missing NEXT_PUBLIC_SUPABASE_URL (.env.local)",
  );
  assert(
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
    "Missing SUPABASE_SERVICE_ROLE_KEY (.env.local)",
  );

  const supabase = createServiceRoleClient();
  const ids = await resolveDevIds(supabase);
  const { salonId, serviceId, staffId } = ids;

  const slotUtc = "2038-06-01T18:00:00.000Z";
  let bookingId = "";

  await smoke("1. Add walk-in → succeeds", async () => {
    const r = await smokeAddWalkinToQueue(supabase, salonId, serviceId);
    assert(r.ok === true && r.bookingId, JSON.stringify(r));
    bookingId = r.ok ? r.bookingId : "";
    assert(UUID_RE.test(bookingId), "booking id uuid");
  });

  await smoke("2. Assign walk-in to fresh slot → succeeds", async () => {
    assert(bookingId, "no booking from step 1");
    const r = await smokeAssignWalkinToSlot(
      supabase,
      salonId,
      bookingId,
      staffId,
      slotUtc,
    );
    assert(r.ok === true, JSON.stringify(r));
  });

  await smoke(
    "3. Assign same walk-in again → fails invalid_state / lost_race",
    async () => {
      assert(bookingId, "no booking");
      const r = await smokeAssignWalkinToSlot(
        supabase,
        salonId,
        bookingId,
        staffId,
        slotUtc,
      );
      assert(
        r.ok === false &&
          (r.error === "invalid_state" || r.error === "lost_race"),
        `expected invalid_state or lost_race, got ${JSON.stringify(r)}`,
      );
    },
  );

  await smoke("4. undoWalkinAssignment → succeeds", async () => {
    assert(bookingId, "no booking");
    const r = await smokeUndoWalkinAssignment(supabase, salonId, bookingId);
    assert(r.ok === true, JSON.stringify(r));
  });

  await smoke("5. Re-assign same walk-in to slot → succeeds", async () => {
    assert(bookingId, "no booking");
    const r = await smokeAssignWalkinToSlot(
      supabase,
      salonId,
      bookingId,
      staffId,
      slotUtc,
    );
    assert(r.ok === true, JSON.stringify(r));
  });

  await smoke("6. markWalkinInProgress → succeeds", async () => {
    assert(bookingId, "no booking");
    const r = await smokeMarkWalkinInProgress(supabase, salonId, bookingId);
    assert(r.ok === true, JSON.stringify(r));
  });

  await smoke(
    "7. undoWalkinAssignment on in-progress → fails already_started",
    async () => {
      assert(bookingId, "no booking");
      const r = await smokeUndoWalkinAssignment(supabase, salonId, bookingId);
      assert(
        r.ok === false && r.error === "already_started",
        JSON.stringify(r),
      );
    },
  );

  await smoke(
    "8. Add walk-in → cancelWaitingWalkin → status cancelled in DB",
    async () => {
      const rAdd = await smokeAddWalkinToQueue(supabase, salonId, serviceId);
      assert(rAdd.ok === true, JSON.stringify(rAdd));
      const cancelId = rAdd.bookingId;
      const rCancel = await smokeCancelWaitingWalkin(supabase, salonId, cancelId);
      assert(rCancel.ok === true, JSON.stringify(rCancel));
      const { data: row, error: selErr } = await supabase
        .from("bookings")
        .select("status")
        .eq("id", cancelId)
        .maybeSingle();
      assert(!selErr && row?.status === "cancelled", JSON.stringify(selErr ?? row));
      await supabase.from("bookings").delete().eq("id", cancelId);
    },
  );

  await smoke(
    "9. Appointment pending → updateBookingStatus in_progress → started_at set",
    async () => {
      const slot = "2038-09-01T14:00:00.000Z";
      const ins = await smokeInsertAppointmentBooking(
        supabase,
        salonId,
        serviceId,
        staffId,
        slot,
        "pending",
      );
      assert(ins.ok === true, JSON.stringify(ins));
      const bid = ins.bookingId;
      const r = await smokeMirrorUpdateBookingStatus(
        supabase,
        salonId,
        bid,
        "in_progress",
      );
      assert(r.ok === true, JSON.stringify(r));
      const { data: row, error: selErr } = await supabase
        .from("bookings")
        .select("status, started_at")
        .eq("id", bid)
        .maybeSingle();
      assert(
        !selErr &&
          row?.status === "in_progress" &&
          row?.started_at != null &&
          String(row.started_at).length > 0,
        JSON.stringify(selErr ?? row),
      );
      await supabase.from("bookings").delete().eq("id", bid);
    },
  );

  await smoke(
    "10. Appointment pending → completed direct → invalid_transition",
    async () => {
      const slot = "2038-09-02T14:00:00.000Z";
      const ins = await smokeInsertAppointmentBooking(
        supabase,
        salonId,
        serviceId,
        staffId,
        slot,
        "pending",
      );
      assert(ins.ok === true, JSON.stringify(ins));
      const bid = ins.bookingId;
      const r = await smokeMirrorUpdateBookingStatus(
        supabase,
        salonId,
        bid,
        "completed",
      );
      assert(
        r.ok === false && r.error === "invalid_transition",
        JSON.stringify(r),
      );
      await supabase.from("bookings").delete().eq("id", bid);
    },
  );

  await smoke(
    "11. Appointment pending → in_progress → completed lifecycle",
    async () => {
      const slot = "2038-09-03T14:00:00.000Z";
      const ins = await smokeInsertAppointmentBooking(
        supabase,
        salonId,
        serviceId,
        staffId,
        slot,
        "pending",
      );
      assert(ins.ok === true, JSON.stringify(ins));
      const bid = ins.bookingId;
      const r1 = await smokeMirrorUpdateBookingStatus(
        supabase,
        salonId,
        bid,
        "in_progress",
      );
      assert(r1.ok === true, JSON.stringify(r1));
      const r2 = await smokeMirrorUpdateBookingStatus(
        supabase,
        salonId,
        bid,
        "completed",
      );
      assert(r2.ok === true, JSON.stringify(r2));
      const { data: row, error: selErr } = await supabase
        .from("bookings")
        .select("status")
        .eq("id", bid)
        .maybeSingle();
      assert(!selErr && row?.status === "completed", JSON.stringify(selErr ?? row));
      await supabase.from("bookings").delete().eq("id", bid);
    },
  );

  await smoke(
    "12. Appointment confirmed → cancelDeskBooking → cancelled",
    async () => {
      const slot = "2038-09-04T14:00:00.000Z";
      const ins = await smokeInsertAppointmentBooking(
        supabase,
        salonId,
        serviceId,
        staffId,
        slot,
        "confirmed",
      );
      assert(ins.ok === true, JSON.stringify(ins));
      const bid = ins.bookingId;
      const r = await smokeMirrorCancelDeskBooking(supabase, salonId, bid);
      assert(r.ok === true, JSON.stringify(r));
      const { data: row, error: selErr } = await supabase
        .from("bookings")
        .select("status")
        .eq("id", bid)
        .maybeSingle();
      assert(!selErr && row?.status === "cancelled", JSON.stringify(selErr ?? row));
      await supabase.from("bookings").delete().eq("id", bid);
    },
  );

  console.log(`${pass} passed, ${failed} failed`);
  await supabase.from("bookings").delete().eq("id", bookingId);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
