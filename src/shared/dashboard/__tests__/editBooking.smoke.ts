/**
 * Manual smoke — `performEditBooking` (same logic as server `editBooking` in receptionistActions).
 * Requires `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) and a salon with
 * at least **2 staff** and **2 services** (pins: `NAILIQ_SMOKE_SALON_ID` or slug `NAILIQ_SMOKE_SLUG`).
 *
 * Run: `npx tsx src/shared/dashboard/__tests__/editBooking.smoke.ts`
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

import { createServiceRoleClient } from "../../lib/supabase/serviceRole";
import {
  type EditBookingInput,
  performEditBooking,
} from "../editBookingCore";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SLUG_FALLBACK =
  process.env.NAILIQ_SMOKE_SLUG?.trim() || "nailiq-demo-slug";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

type Resolved = {
  salonId: string;
  staffIds: [string, string];
  serviceIds: [string, string];
};

async function resolveSalonTwoStaffTwoServices(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<Resolved> {
  const pinned = process.env.NAILIQ_SMOKE_SALON_ID?.trim() ?? "";

  let salonId: string | null = null;
  if (pinned && UUID_RE.test(pinned)) {
    const { data, error } = await supabase
      .from("salons")
      .select("id")
      .eq("id", pinned)
      .maybeSingle();
    assert(!error, error?.message ?? "salon by id failed");
    if (data?.id) salonId = String(data.id);
  }

  if (!salonId) {
    const { data: bySlug, error: se } = await supabase
      .from("salons")
      .select("id")
      .eq("slug", SLUG_FALLBACK)
      .maybeSingle();
    if (!se && bySlug?.id) salonId = String(bySlug.id);
  }

  if (!salonId) {
    const { data: anySalon } = await supabase
      .from("salons")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    assert(anySalon?.id, `no salon rows (slug '${SLUG_FALLBACK}' missing?)`);
    salonId = String(anySalon.id);
  }

  const { data: staffRows, error: stErr } = await supabase
    .from("staff")
    .select("id")
    .eq("salon_id", salonId)
    .limit(2);

  assert(!stErr, stErr?.message ?? "staff query failed");
  assert(
    staffRows && staffRows.length >= 2,
    `[smoke] need ≥2 staff for salon ${salonId}`,
  );

  const { data: svcRows, error: svErr } = await supabase
    .from("services")
    .select("id, duration_minutes")
    .eq("salon_id", salonId)
    .gte("duration_minutes", 1)
    .limit(2);

  assert(!svErr, svErr?.message ?? "services query failed");
  assert(
    svcRows && svcRows.length >= 2,
    `[smoke] need ≥2 services (duration≥1) for salon ${salonId}`,
  );

  return {
    salonId,
    staffIds: [String(staffRows[0]!.id), String(staffRows[1]!.id)],
    serviceIds: [String(svcRows[0]!.id), String(svcRows[1]!.id)],
  };
}

async function insertAppointment(
  supabase: ReturnType<typeof createServiceRoleClient>,
  args: {
    salonId: string;
    staffId: string;
    serviceId: string;
    slotStartUtc: string;
    status: "pending" | "confirmed";
    clientName: string;
  },
): Promise<string> {
  const startMs = Date.parse(args.slotStartUtc);
  assert(!Number.isNaN(startMs), "invalid slot start");

  const { data: svc, error: svcErr } = await supabase
    .from("services")
    .select("id, duration_minutes, buffer_minutes, price_cents")
    .eq("id", args.serviceId)
    .eq("salon_id", args.salonId)
    .maybeSingle();

  assert(!svcErr, svcErr?.message ?? "service lookup");
  assert(svc?.id, "service not found");

  const duration = Math.round(Number(svc.duration_minutes ?? 0));
  const buffer = Math.round(Number(svc.buffer_minutes ?? 0));
  const totalMin = duration + buffer;
  const slotEndUtc = new Date(startMs + totalMin * 60 * 1000).toISOString();
  const price = svc.price_cents != null ? Math.round(Number(svc.price_cents)) : null;

  const { data: inserted, error: insErr } = await supabase
    .from("bookings")
    .insert({
      salon_id: args.salonId,
      service_id: args.serviceId,
      client_name: args.clientName,
      client_phone: null,
      client_notes: null,
      staff_id: args.staffId,
      start_time_utc: args.slotStartUtc,
      end_time_utc: slotEndUtc,
      status: args.status,
      source: "appointment",
      joined_queue_at: null,
      staff_request_note: null,
      price_cents: Number.isFinite(price ?? NaN) ? price : null,
    })
    .select("id")
    .maybeSingle();

  assert(!insErr, insErr?.message ?? "insert failed");
  const id = inserted && "id" in inserted ? String(inserted.id) : "";
  assert(id && UUID_RE.test(id), "no booking id");
  return id;
}

let pass = 0;
let fail = 0;

async function caseRun(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`PASS — ${name}`);
  } catch (e) {
    fail++;
    console.error(`FAIL — ${name}`);
    console.error(e);
  }
}

async function main() {
  assert(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(),
    "Missing NEXT_PUBLIC_SUPABASE_URL",
  );
  assert(
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
    "Missing SUPABASE_SERVICE_ROLE_KEY",
  );

  const supabase = createServiceRoleClient();
  const resolved = await resolveSalonTwoStaffTwoServices(supabase);
  const trackDelete: string[] = [];

  const [staffA, staffB] = resolved.staffIds;
  const [svcA] = resolved.serviceIds;

  await caseRun(
    "1. Edit time, same staff, no conflict → success + updated row",
    async () => {
      const startA = "2038-09-01T14:00:00.000Z";
      const startB = "2038-09-01T17:00:00.000Z";
      const bid = await insertAppointment(supabase, {
        salonId: resolved.salonId,
        staffId: staffA,
        serviceId: svcA,
        slotStartUtc: startA,
        status: "confirmed",
        clientName: "Smoke Alice",
      });
      trackDelete.push(bid);

      const inp: EditBookingInput = {
        salonId: resolved.salonId,
        bookingId: bid,
        newStartTimeUtc: startB,
        newStaffId: staffA,
        newServiceId: svcA,
      };
      const r = await performEditBooking(supabase, resolved.salonId, inp);
      assert(r.ok === true && r.updated.id === bid, JSON.stringify(r));
      assert(r.ok === true && r.updated.start_time_utc != null, "missing start");
      assert(
        r.ok &&
          Date.parse(r.updated.start_time_utc!) === Date.parse(startB),
        `start mismatch got ${r.ok ? r.updated.start_time_utc : ""}`,
      );
    },
  );

  await caseRun("2. Edit to different staff, no conflict → success", async () => {
    const startA = "2038-09-02T14:00:00.000Z";
    const startSame = startA;
    const bid = await insertAppointment(supabase, {
      salonId: resolved.salonId,
      staffId: staffA,
      serviceId: svcA,
      slotStartUtc: startA,
      status: "pending",
      clientName: "Smoke Bob",
    });
    trackDelete.push(bid);

    const inp: EditBookingInput = {
      salonId: resolved.salonId,
      bookingId: bid,
      newStartTimeUtc: startSame,
      newStaffId: staffB,
      newServiceId: svcA,
    };
    const r = await performEditBooking(supabase, resolved.salonId, inp);
    assert(r.ok === true, JSON.stringify(r));
  });

  await caseRun(
    "3. Edit into occupied slot → slot_conflict + conflictWith",
    async () => {
      const { data: svcRow } = await supabase
        .from("services")
        .select("duration_minutes, buffer_minutes")
        .eq("id", svcA)
        .eq("salon_id", resolved.salonId)
        .maybeSingle();
      assert(svcRow, "svc");
      const d = Math.round(Number(svcRow.duration_minutes ?? 0));
      const b = Math.round(Number(svcRow.buffer_minutes ?? 0));
      const mins = d + b;
      assert(Number.isFinite(mins) && mins >= 1, "bad duration");

      const t0Ms = Date.parse("2038-09-03T10:00:00.000Z");
      assert(!Number.isNaN(t0Ms), "t0");
      const startSubject = new Date(t0Ms).toISOString();
      const startBlocker = new Date(t0Ms + mins * 60 * 1000).toISOString();

      const blockerName = "Smoke EditBooking Blocker Zoe";
      const blockerId = await insertAppointment(supabase, {
        salonId: resolved.salonId,
        staffId: staffA,
        serviceId: svcA,
        slotStartUtc: startBlocker,
        status: "confirmed",
        clientName: blockerName,
      });
      trackDelete.push(blockerId);

      const subjectId = await insertAppointment(supabase, {
        salonId: resolved.salonId,
        staffId: staffA,
        serviceId: svcA,
        slotStartUtc: startSubject,
        status: "pending",
        clientName: "Smoke Carl",
      });
      trackDelete.push(subjectId);

      const inp: EditBookingInput = {
        salonId: resolved.salonId,
        bookingId: subjectId,
        newStartTimeUtc: startBlocker,
        newStaffId: staffA,
        newServiceId: svcA,
      };
      const r = await performEditBooking(supabase, resolved.salonId, inp);
      assert(
        r.ok === false &&
          r.error === "slot_conflict" &&
          r.conflictWith === blockerName,
        JSON.stringify(r),
      );
    },
  );

  await caseRun("4. in_progress booking → invalid_status", async () => {
    const bid = await insertAppointment(supabase, {
      salonId: resolved.salonId,
      staffId: staffA,
      serviceId: svcA,
      slotStartUtc: "2038-09-04T11:00:00.000Z",
      status: "pending",
      clientName: "Smoke Dana",
    });
    trackDelete.push(bid);

    const startedAt = new Date().toISOString();
    const { data: progressed, error: upErr } = await supabase
      .from("bookings")
      .update({ status: "in_progress", started_at: startedAt })
      .eq("id", bid)
      .eq("salon_id", resolved.salonId)
      .select("id")
      .maybeSingle();
    assert(!upErr && progressed?.id, upErr?.message ?? "prog");

    const inp: EditBookingInput = {
      salonId: resolved.salonId,
      bookingId: bid,
      newStartTimeUtc: "2038-09-04T14:00:00.000Z",
      newStaffId: staffA,
      newServiceId: svcA,
    };
    const r = await performEditBooking(supabase, resolved.salonId, inp);
    assert(r.ok === false && r.error === "invalid_status", JSON.stringify(r));
  });

  await caseRun("5. Non-existent bookingId → not_found", async () => {
    const ghost = randomUUID();
    const inp: EditBookingInput = {
      salonId: resolved.salonId,
      bookingId: ghost,
      newStartTimeUtc: "2038-09-05T09:00:00.000Z",
      newStaffId: staffA,
      newServiceId: svcA,
    };
    const r = await performEditBooking(supabase, resolved.salonId, inp);
    assert(r.ok === false && r.error === "not_found", JSON.stringify(r));
  });

  for (const id of trackDelete) {
    await supabase.from("bookings").delete().eq("id", id);
  }

  console.log(`${pass} PASS, ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
