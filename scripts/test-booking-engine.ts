import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

/** Same as test-booking-flow: load `.env.local` when running `npx tsx scripts/...`. */
function loadEnvLocalIfPresent() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvLocalIfPresent();

type TestOutcome = "pass" | "fail" | "skipped";

type TestResultRow = {
  name: string;
  outcome: TestOutcome;
  errorCode?: string;
  errorMessage?: string;
  detail?: string;
};

/** Public booking RPC params (see `20260430250000_create_public_booking_business_rules.sql`). */
type CreatePublicBookingRpcParams = {
  p_salon_id: string;
  p_service_id: string;
  p_staff_id: string;
  p_client_name: string;
  p_client_phone: string;
  p_start_time_utc: string;
  p_end_time_utc: string;
  p_status?: string;
  p_price_cents?: number | null;
  p_client_notes?: string | null;
  p_addon_service_id?: string | null;
  p_addon_price_cents?: number | null;
};

function requireBookingEnv(): void {
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()) {
    missing.push("NEXT_PUBLIC_SUPABASE_URL");
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()) {
    missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    missing.push("SUPABASE_SERVICE_ROLE_KEY");
  }
  if (missing.length === 0) return;
  console.error(
    "Missing required environment variables for the booking test suite:\n" +
      missing.map((k) => `  - ${k}`).join("\n") +
      "\n\nLoad them via `.env.local` and run:\n" +
      "  npx tsx --env-file=.env.local scripts/test-booking-engine.ts\n",
  );
  process.exit(1);
}

function parseRepeatCount(): number {
  const raw = process.env.TEST_REPEAT?.trim();
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

requireBookingEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseService = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/** Public booking path (matches production anon clients). */
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON);

const TEST_SALON = "liam-nails";

/** Isolated UTC weekday for slot tests: Monday (opening_hours seed has Sun closed). */
const TEST_DAY = "2035-08-13";
/** Sunday UTC — default opening_hours marks Sun closed (outside_hours / closed day). */
const TEST_SUNDAY_UTC = "2035-08-12";

/**
 * Pinned for `testRpcClosedDayOrOutsideHours` only (restored after).
 * Mon 09:00–18:00 so 04:00 UTC is unambiguously before open (DB may use earlier opens).
 * `sun: null` matches RPC `(v_hours -> 'sun') is null` / non-object → outside_hours.
 */
const PINNED_OPENING_HOURS_FOR_OUTSIDE_TEST: Record<string, unknown> = {
  mon: { open: "09:00", close: "18:00", closed: false },
  tue: { open: "09:00", close: "18:00", closed: false },
  wed: { open: "09:00", close: "18:00", closed: false },
  thu: { open: "09:00", close: "18:00", closed: false },
  fri: { open: "09:00", close: "18:00", closed: false },
  sat: { open: "10:00", close: "16:00", closed: false },
  sun: null,
};

let bookingCtx: { salonId: string; serviceId: string; staffId: string } | null =
  null;

/** `TEST_*` + SQL `LIKE` treats `_` as wildcard — use a safe literal prefix. */
function makeRunClientPrefix(): string {
  return `NQTEST-${randomBytes(6).toString("hex")}`;
}

function clientName(runPrefix: string, label: string): string {
  return `${runPrefix}-${label}-${randomBytes(3).toString("hex")}`;
}

function unwrapRpcBookingPayload(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data;
}

/** JSON failure payload from `create_public_booking` (HTTP 200). */
function rpcJsonFailureCode(data: unknown): string | null {
  const raw = unwrapRpcBookingPayload(data);
  if (
    raw &&
    typeof raw === "object" &&
    (raw as { success?: unknown }).success === false &&
    typeof (raw as { code?: unknown }).code === "string"
  ) {
    return (raw as { code: string }).code;
  }
  return null;
}

/** Structured conflict from `create_public_booking` (HTTP 200 + JSON body). */
function isRpcJsonConflict(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "success" in data &&
    (data as { success?: unknown }).success === false &&
    "code" in data &&
    typeof (data as { code?: unknown }).code === "string" &&
    ((data as { code: string }).code === "slot_conflict" ||
      (data as { code: string }).code === "duplicate_booking")
  );
}

/** DB may reject double-book via GiST exclusion (23P01) or unique overlap (23505). */
function isSlotConflictError(err: {
  code?: string;
  message?: string;
} | null): boolean {
  if (!err) return false;
  if (err.code === "23P01" || err.code === "23505") return true;
  const m = typeof err.message === "string" ? err.message.toLowerCase() : "";
  return (
    m.includes("exclusion constraint") ||
    m.includes("bookings_no_overlap") ||
    m.includes("slot_taken")
  );
}

function endTimeUtcAfterStart(startIso: string, ms: number): string {
  const t = Date.parse(startIso);
  const startMs = Number.isFinite(t) ? t : Date.now();
  return new Date(startMs + ms).toISOString();
}

function defaultHourEnd(startIso: string): string {
  return endTimeUtcAfterStart(startIso, 60 * 60 * 1000);
}

function rpcCreatePublicBooking(params: CreatePublicBookingRpcParams) {
  return supabaseAnon.rpc("create_public_booking", {
    p_salon_id: params.p_salon_id,
    p_service_id: params.p_service_id,
    p_staff_id: params.p_staff_id,
    p_client_name: params.p_client_name,
    p_client_phone: params.p_client_phone,
    p_start_time_utc: params.p_start_time_utc,
    p_end_time_utc: params.p_end_time_utc,
    p_status: params.p_status ?? "pending",
    p_price_cents: params.p_price_cents ?? null,
    p_client_notes: params.p_client_notes ?? null,
    p_addon_service_id: params.p_addon_service_id ?? null,
    p_addon_price_cents: params.p_addon_price_cents ?? null,
  });
}

/** Remove any row at this exact slot (handles leftover prod/manual or aborted runs). */
async function deleteAnyBookingAtStaffSlot(
  staffId: string,
  startUtcIso: string,
): Promise<void> {
  const { error } = await supabaseService
    .from("bookings")
    .delete()
    .eq("staff_id", staffId)
    .eq("start_time_utc", startUtcIso);
  if (error)
    throw new Error(`Could not clear slot for concurrent test: ${error.message}`);
}

async function loadBookingTestCtx(): Promise<string | null> {
  const slug = TEST_SALON.trim().toLowerCase();

  const { data: salon, error: salonErr } = await supabaseAnon
    .from("salons")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();

  if (salonErr) return salonErr.message;
  if (!salon?.id) return `salon slug not found: ${slug}`;

  const { data: svc, error: svcErr } = await supabaseAnon
    .from("services")
    .select("id")
    .eq("salon_id", salon.id)
    .limit(1)
    .maybeSingle();

  if (svcErr) return svcErr.message;
  if (!svc?.id) return `no services for salon ${slug}`;

  const { data: st, error: stErr } = await supabaseAnon
    .from("staff")
    .select("id")
    .eq("salon_id", salon.id)
    .limit(1)
    .maybeSingle();

  if (stErr) return stErr.message;
  if (!st?.id) return `no staff for salon ${slug}`;

  bookingCtx = {
    salonId: salon.id as string,
    serviceId: svc.id as string,
    staffId: st.id as string,
  };
  return null;
}

/**
 * Remove rows from prior runs. `NQTEST-%` avoids `_` wildcard issues with `TEST_%`.
 */
async function deleteNqTestPrefixedBookings(): Promise<void> {
  const { error } = await supabaseService
    .from("bookings")
    .delete({ count: "exact" })
    .ilike("client_name", "NQTEST-%");

  if (error) throw new Error(`Cleanup failed: ${error.message} (${error.code})`);
}

async function insertBookingDirect(input: {
  start_time_utc: string;
  end_time_utc: string;
  client_name: string;
  client_phone?: string | null;
}) {
  const ctx = bookingCtx!;

  return supabaseAnon.from("bookings").insert({
    salon_id: ctx.salonId,
    service_id: ctx.serviceId,
    staff_id: ctx.staffId,
    client_name: input.client_name,
    client_phone: input.client_phone ?? "+10000000000",
    start_time_utc: input.start_time_utc,
    end_time_utc: input.end_time_utc,
    status: "pending",
  });
}

async function createBookingHourFromStart(
  runPrefix: string,
  timeIso: string,
  label: string,
) {
  return insertBookingDirect({
    start_time_utc: timeIso,
    end_time_utc: defaultHourEnd(timeIso),
    client_name: clientName(runPrefix, label),
  });
}

async function assertBookingRowExists(
  bookingId: string,
  expectedStatus?: string,
): Promise<void> {
  const { data, error } = await supabaseService
    .from("bookings")
    .select("id, client_name, status")
    .eq("id", bookingId)
    .maybeSingle();

  if (error)
    throw new Error(
      `Service role could not verify booking row: ${error.message} (${error.code})`,
    );
  if (!data?.id)
    throw new Error(`Booking row missing for id ${bookingId} after RPC success.`);
  if (expectedStatus != null && data.status !== expectedStatus) {
    throw new Error(
      `Booking status mismatch for ${bookingId}: expected "${expectedStatus}", got "${String(data.status)}".`,
    );
  }
}

function logFailDetails(err: { message?: string; code?: string; details?: string }) {
  console.log("error code:", err.code ?? "(none)");
  console.log("error message:", err.message ?? "(none)");
  if (err.details) console.log("detail:", err.details);
}

async function runCase(
  name: string,
  expected: string,
  fn: () => Promise<void | "skipped">,
): Promise<TestResultRow> {
  console.log("\n========================");
  console.log("TEST:", name);
  console.log("EXPECTED:", expected);
  try {
    const maybeSkip = await fn();
    if (maybeSkip === "skipped") {
      console.log("RESULT: SKIPPED");
      return { name, outcome: "skipped" };
    }
    console.log("RESULT: PASS");
    return { name, outcome: "pass" };
  } catch (e) {
    const err = e as Error & { code?: string; details?: string };
    console.log("RESULT: FAIL");
    logFailDetails(err);
    return {
      name,
      outcome: "fail",
      errorCode: err.code,
      errorMessage: err.message,
    };
  }
}

// --- Existing direct-insert tests (kept; assertions preserved) ---

async function testCreateBooking(runPrefix: string) {
  return runCase(
    "CREATE BOOKING (direct insert)",
    "Anon insert succeeds for a valid future slot.",
    async () => {
      await deleteNqTestPrefixedBookings();
      const start = `${TEST_DAY}T15:00:00.000Z`;
      const { data, error } = await createBookingHourFromStart(
        runPrefix,
        start,
        "create",
      );
      if (error) {
        logFailDetails(error);
        throw new Error(
          `Expected booking to succeed: ${error.message} (${error.code})`,
        );
      }
      if (data == null) console.log("(insert returned no row; anon select blocked — OK)");
    },
  );
}

async function testDoubleBooking(runPrefix: string) {
  return runCase(
    "DOUBLE BOOKING (direct insert)",
    "Second insert for same staff/slot is blocked (23P01 / 23505 or overlap message).",
    async () => {
      await deleteNqTestPrefixedBookings();
      const time = `${TEST_DAY}T16:00:00.000Z`;
      const name2 = clientName(runPrefix, "db-b");

      const { error: errorFirst } = await createBookingHourFromStart(
        runPrefix,
        time,
        "db-first",
      );
      if (errorFirst) {
        logFailDetails(errorFirst);
        throw new Error(
          `Expected first booking to succeed: ${errorFirst.message} (${errorFirst.code})`,
        );
      }

      const { error } = await insertBookingDirect({
        start_time_utc: time,
        end_time_utc: defaultHourEnd(time),
        client_name: name2,
      });
      if (error) logFailDetails(error);
      if (!error) throw new Error("Expected double booking to be blocked (exclusion)");
      if (!isSlotConflictError(error))
        throw new Error(
          `Expected slot conflict (exclusion or unique); got ${error.message} (${error.code})`,
        );
    },
  );
}

async function testOverlapPartial(runPrefix: string) {
  return runCase(
    "PARTIAL OVERLAP (direct insert)",
    "Overlapping range for same staff is blocked.",
    async () => {
      await deleteNqTestPrefixedBookings();
      const sA = `${TEST_DAY}T15:00:00.000Z`;
      const eA = `${TEST_DAY}T16:00:00.000Z`;
      const sB = `${TEST_DAY}T15:30:00.000Z`;
      const eB = `${TEST_DAY}T16:30:00.000Z`;

      const { error: e1 } = await insertBookingDirect({
        start_time_utc: sA,
        end_time_utc: eA,
        client_name: clientName(runPrefix, "ov-a"),
      });
      if (e1) {
        logFailDetails(e1);
        throw new Error(`Expected first slot to succeed: ${e1.message} (${e1.code})`);
      }

      const { error: e2 } = await insertBookingDirect({
        start_time_utc: sB,
        end_time_utc: eB,
        client_name: clientName(runPrefix, "ov-b"),
      });
      if (e2) logFailDetails(e2);
      if (!e2) throw new Error("Expected overlapping booking to be blocked");
      if (!isSlotConflictError(e2))
        throw new Error(
          `Expected slot conflict (exclusion or unique); got ${e2.message} (${e2.code})`,
        );
    },
  );
}

async function testDifferentTime(runPrefix: string) {
  return runCase(
    "DIFFERENT TIME (direct insert)",
    "Another valid future slot succeeds.",
    async () => {
      await deleteNqTestPrefixedBookings();
      const start = `${TEST_DAY}T19:00:00.000Z`;
      const { error } = await createBookingHourFromStart(runPrefix, start, "diff");
      if (error) {
        logFailDetails(error);
        throw new Error(
          `Expected booking to succeed: ${error.message} (${error.code})`,
        );
      }
    },
  );
}

async function testInvalidData() {
  return runCase(
    "INVALID DATA (direct insert)",
    "Omitting required fields fails (NOT NULL / constraint).",
    async () => {
      await deleteNqTestPrefixedBookings();
      const { error } = await supabaseAnon.from("bookings").insert({
        salon_id: bookingCtx!.salonId,
      });

      if (!error) throw new Error("Expected invalid insert to fail (NOT NULL / constraint)");
      logFailDetails(error);
    },
  );
}

async function testConcurrentBooking(runPrefix: string) {
  return runCase(
    "CONCURRENT BOOKING (direct insert)",
    "Exactly one of two parallel inserts for the same slot wins; other sees slot conflict.",
    async () => {
      await deleteNqTestPrefixedBookings();
      const time = `${TEST_DAY}T20:00:00.000Z`;
      await deleteAnyBookingAtStaffSlot(bookingCtx!.staffId, time);
      const results = await Promise.all([
        createBookingHourFromStart(runPrefix, time, "conc-a"),
        createBookingHourFromStart(runPrefix, time, "conc-b"),
      ]);

      const success = results.filter((r) => !r.error).length;
      if (success !== 1) {
        for (const r of results)
          if (r.error) logFailDetails(r.error);
        throw new Error(
          `Expected exactly 1 successful concurrent insert; got ${success}`,
        );
      }

      const failed = results.filter((r) => r.error);
      if (failed.length !== 1 || !isSlotConflictError(failed[0].error!)) {
        throw new Error(
          `Expected exactly 1 failed request with slot conflict; ` +
            `failed=${failed.length} last=${failed[0]?.error?.message}`,
        );
      }
    },
  );
}

// --- RPC tests ---

async function testCreatePublicBookingRpc(runPrefix: string) {
  return runCase(
    "CREATE PUBLIC BOOKING (RPC)",
    "create_public_booking returns JSON success + booking_id; row status confirmed.",
    async () => {
      await deleteNqTestPrefixedBookings();
      const ctx = bookingCtx!;
      const start = `${TEST_DAY}T12:00:00.000Z`;
      const end = defaultHourEnd(start);
      const cname = clientName(runPrefix, "rpc-create");

      const { data, error } = await rpcCreatePublicBooking({
        p_salon_id: ctx.salonId,
        p_service_id: ctx.serviceId,
        p_staff_id: ctx.staffId,
        p_client_name: cname,
        p_client_phone: "+10000000001",
        p_start_time_utc: start,
        p_end_time_utc: end,
      });

      if (error) {
        logFailDetails(error);
        throw new Error(`RPC failed: ${error.message} (${error.code})`);
      }
      const raw = unwrapRpcBookingPayload(data);
      if (!raw || typeof raw !== "object") {
        throw new Error("RPC returned no JSON payload");
      }
      const row = raw as Record<string, unknown>;
      if (row.success !== true) {
        throw new Error(
          `RPC expected success: true, got ${JSON.stringify(raw)}`,
        );
      }
      const id =
        typeof row.booking_id === "string" && row.booking_id
          ? row.booking_id
          : "";
      if (!id) throw new Error("RPC returned no booking_id");

      await assertBookingRowExists(id, "confirmed");
    },
  );
}

async function testRpcDoubleBookingBlocked(runPrefix: string) {
  return runCase(
    "RPC DOUBLE BOOKING",
    "First RPC succeeds; second RPC for same staff/service/time is blocked.",
    async () => {
      await deleteNqTestPrefixedBookings();
      const ctx = bookingCtx!;
      const start = `${TEST_DAY}T13:00:00.000Z`;
      const end = defaultHourEnd(start);

      const { data: d1, error: e1 } = await rpcCreatePublicBooking({
        p_salon_id: ctx.salonId,
        p_service_id: ctx.serviceId,
        p_staff_id: ctx.staffId,
        p_client_name: clientName(runPrefix, "rpc-d1"),
        p_client_phone: "+10000000002",
        p_start_time_utc: start,
        p_end_time_utc: end,
      });
      if (e1) {
        logFailDetails(e1);
        throw new Error(`Expected first RPC to succeed: ${e1.message}`);
      }
      const p1 = unwrapRpcBookingPayload(d1);
      if (
        typeof p1 !== "object" ||
        p1 === null ||
        (p1 as { success?: unknown }).success !== true
      ) {
        throw new Error("Expected first RPC to return JSON success");
      }

      const { data: d2, error: e2 } = await rpcCreatePublicBooking({
        p_salon_id: ctx.salonId,
        p_service_id: ctx.serviceId,
        p_staff_id: ctx.staffId,
        p_client_name: clientName(runPrefix, "rpc-d2"),
        p_client_phone: "+10000000003",
        p_start_time_utc: start,
        p_end_time_utc: end,
      });

      const jsonConflict = isRpcJsonConflict(unwrapRpcBookingPayload(d2));
      if (!e2 && !jsonConflict) {
        throw new Error("Expected second RPC to be blocked for same slot");
      }
      if (e2) {
        logFailDetails(e2);
        if (!isSlotConflictError(e2)) {
          throw new Error(
            `Expected slot conflict on second RPC; got ${e2.message} (${e2.code})`,
          );
        }
      } else if (!jsonConflict) {
        throw new Error("Expected JSON slot_conflict on second RPC");
      }
    },
  );
}

async function testRpcPastTimeBlocked(runPrefix: string) {
  return runCase(
    "RPC PAST TIME",
    "Booking in the past is rejected when enforced (otherwise documented skip).",
    async () => {
      await deleteNqTestPrefixedBookings();
      const ctx = bookingCtx!;
      const start = "2020-01-01T10:00:00.000Z";
      const end = defaultHourEnd(start);

      const { data, error } = await rpcCreatePublicBooking({
        p_salon_id: ctx.salonId,
        p_service_id: ctx.serviceId,
        p_staff_id: ctx.staffId,
        p_client_name: clientName(runPrefix, "past"),
        p_client_phone: "+10000000004",
        p_start_time_utc: start,
        p_end_time_utc: end,
      });

      const code = rpcJsonFailureCode(data);
      if (code === "invalid_time") return;
      if (error) {
        logFailDetails(error);
        return;
      }
      throw new Error(
        "Expected RPC to reject bookings in the past (invalid_time JSON or Postgres error)",
      );
    },
  );
}

async function testRpcInvalidServiceId(runPrefix: string) {
  return runCase(
    "RPC INVALID SERVICE_ID",
    "Random UUID not in services is rejected (FK / validation).",
    async () => {
      await deleteNqTestPrefixedBookings();
      const ctx = bookingCtx!;
      const start = `${TEST_DAY}T14:00:00.000Z`;
      const end = defaultHourEnd(start);
      const fakeService = randomUUID();

      const { data, error } = await rpcCreatePublicBooking({
        p_salon_id: ctx.salonId,
        p_service_id: fakeService,
        p_staff_id: ctx.staffId,
        p_client_name: clientName(runPrefix, "bad-svc"),
        p_client_phone: "+10000000005",
        p_start_time_utc: start,
        p_end_time_utc: end,
      });

      const code = rpcJsonFailureCode(data);
      if (code === "invalid_reference") return;
      if (error) {
        logFailDetails(error);
        return;
      }
      throw new Error(
        "Expected RPC to fail for unknown service_id (invalid_reference or Postgres error)",
      );
    },
  );
}

async function testRpcInvalidStaffId(runPrefix: string) {
  return runCase(
    "RPC INVALID STAFF_ID",
    "Random UUID not in staff is rejected (FK / validation).",
    async () => {
      await deleteNqTestPrefixedBookings();
      const ctx = bookingCtx!;
      const start = `${TEST_DAY}T14:30:00.000Z`;
      const end = defaultHourEnd(start);
      const fakeStaff = randomUUID();

      const { data, error } = await rpcCreatePublicBooking({
        p_salon_id: ctx.salonId,
        p_service_id: ctx.serviceId,
        p_staff_id: fakeStaff,
        p_client_name: clientName(runPrefix, "bad-staff"),
        p_client_phone: "+10000000006",
        p_start_time_utc: start,
        p_end_time_utc: end,
      });

      const code = rpcJsonFailureCode(data);
      if (code === "invalid_reference") return;
      if (error) {
        logFailDetails(error);
        return;
      }
      throw new Error(
        "Expected RPC to fail for unknown staff_id (invalid_reference or Postgres error)",
      );
    },
  );
}

async function testRpcMissingClientPhone(runPrefix: string) {
  return runCase(
    "RPC MISSING CLIENT PHONE",
    "Missing/empty phone blocked when enforced (Postgres NOT NULL still allows '').",
    async () => {
      await deleteNqTestPrefixedBookings();
      const ctx = bookingCtx!;
      const start = `${TEST_DAY}T17:30:00.000Z`;
      const end = defaultHourEnd(start);

      const { data, error } = await rpcCreatePublicBooking({
        p_salon_id: ctx.salonId,
        p_service_id: ctx.serviceId,
        p_staff_id: ctx.staffId,
        p_client_name: clientName(runPrefix, "no-phone"),
        p_client_phone: "",
        p_start_time_utc: start,
        p_end_time_utc: end,
      });

      const code = rpcJsonFailureCode(data);
      if (code === "missing_phone") return;
      if (error) {
        logFailDetails(error);
        return;
      }
      throw new Error(
        "Expected RPC to reject empty phone (missing_phone JSON or Postgres error)",
      );
    },
  );
}

async function testRpcClosedDayOrOutsideHours(runPrefix: string) {
  return runCase(
    "RPC CLOSED DAY / OUTSIDE HOURS",
    "Outside working hours / closed day blocked (UTC wall clock in RPC; see migration NOTICE).",
    async () => {
      await deleteNqTestPrefixedBookings();
      const ctx = bookingCtx!;

      const { data: salonBefore, error: fetchErr } = await supabaseService
        .from("salons")
        .select("opening_hours")
        .eq("id", ctx.salonId)
        .single();

      if (fetchErr) {
        throw new Error(
          `Could not read salon opening_hours for pin/restore: ${fetchErr.message}`,
        );
      }

      const previousHours = salonBefore?.opening_hours;

      const { error: pinErr } = await supabaseService
        .from("salons")
        .update({ opening_hours: PINNED_OPENING_HOURS_FOR_OUTSIDE_TEST })
        .eq("id", ctx.salonId);

      if (pinErr) {
        throw new Error(
          `Could not pin opening_hours for outside-hours RPC test: ${pinErr.message}`,
        );
      }

      try {
        /* 1) Before open window (forced 09:00 Mon in PINNED_*): 04:00 UTC Monday */
        const earlyStart = `${TEST_DAY}T04:00:00.000Z`;
        const earlyEnd = defaultHourEnd(earlyStart);
        console.log("TEST TIME:", earlyStart);

        const { data: dEarly, error: eEarly } = await rpcCreatePublicBooking({
          p_salon_id: ctx.salonId,
          p_service_id: ctx.serviceId,
          p_staff_id: ctx.staffId,
          p_client_name: clientName(runPrefix, "early-utc"),
          p_client_phone: "+10000000008",
          p_start_time_utc: earlyStart,
          p_end_time_utc: earlyEnd,
        });
        const earlyCode = rpcJsonFailureCode(dEarly);
        if (earlyCode !== "outside_hours") {
          if (eEarly) logFailDetails(eEarly);
          throw new Error(
            `Expected result.code===outside_hours before open window; got code=${earlyCode} err=${eEarly?.message}`,
          );
        }

        /* 2) Known Sunday + sun: null in PINNED_* → RPC closed day */
        const sunStart = `${TEST_SUNDAY_UTC}T23:00:00.000Z`;
        const sunEnd = defaultHourEnd(sunStart);
        console.log("TEST TIME:", sunStart);

        const { data: dSun, error: eSun } = await rpcCreatePublicBooking({
          p_salon_id: ctx.salonId,
          p_service_id: ctx.serviceId,
          p_staff_id: ctx.staffId,
          p_client_name: clientName(runPrefix, "sunday-utc"),
          p_client_phone: "+10000000009",
          p_start_time_utc: sunStart,
          p_end_time_utc: sunEnd,
        });
        const sunCode = rpcJsonFailureCode(dSun);
        if (sunCode !== "outside_hours") {
          if (eSun) logFailDetails(eSun);
          throw new Error(
            `Expected result.code===outside_hours on null sun day; got code=${sunCode} err=${eSun?.message}`,
          );
        }
      } finally {
        const { error: restoreErr } = await supabaseService
          .from("salons")
          .update({ opening_hours: previousHours ?? null })
          .eq("id", ctx.salonId);
        if (restoreErr) {
          console.error(
            "[testRpcClosedDayOrOutsideHours] failed to restore opening_hours:",
            restoreErr.message,
          );
        }
      }
    },
  );
}

async function testRpcInvalidDuration(runPrefix: string) {
  return runCase(
    "RPC INVALID DURATION (end < start)",
    "Inverted range is rejected when enforced (clear span via start/end only).",
    async () => {
      await deleteNqTestPrefixedBookings();
      const ctx = bookingCtx!;
      const start = `${TEST_DAY}T22:05:00.000Z`;
      const endBefore = new Date(Date.parse(start) - 60_000).toISOString();

      const { data, error } = await rpcCreatePublicBooking({
        p_salon_id: ctx.salonId,
        p_service_id: ctx.serviceId,
        p_staff_id: ctx.staffId,
        p_client_name: clientName(runPrefix, "dur-inverted"),
        p_client_phone: "+10000000007",
        p_start_time_utc: start,
        p_end_time_utc: endBefore,
      });

      const code = rpcJsonFailureCode(data);
      if (code === "invalid_time") return;
      if (error) {
        logFailDetails(error);
        return;
      }
      throw new Error(
        "Expected RPC to reject end_time before start_time (invalid_time JSON or Postgres error)",
      );
    },
  );
}

async function runAllTests(runPrefix: string): Promise<TestResultRow[]> {
  const out: TestResultRow[] = [];
  const sequential = [
    () => testCreateBooking(runPrefix),
    () => testDoubleBooking(runPrefix),
    () => testOverlapPartial(runPrefix),
    () => testDifferentTime(runPrefix),
    () => testInvalidData(),
    () => testConcurrentBooking(runPrefix),
    () => testCreatePublicBookingRpc(runPrefix),
    () => testRpcDoubleBookingBlocked(runPrefix),
    () => testRpcPastTimeBlocked(runPrefix),
    () => testRpcInvalidServiceId(runPrefix),
    () => testRpcInvalidStaffId(runPrefix),
    () => testRpcMissingClientPhone(runPrefix),
    () => testRpcClosedDayOrOutsideHours(runPrefix),
    () => testRpcInvalidDuration(runPrefix),
  ];
  for (const t of sequential) out.push(await t());
  return out;
}

function printSummary(rows: TestResultRow[]) {
  const total = rows.length;
  const passed = rows.filter((r) => r.outcome === "pass").length;
  const failed = rows.filter((r) => r.outcome === "fail").length;
  const skipped = rows.filter((r) => r.outcome === "skipped").length;

  console.log("\n========================");
  console.log("SUMMARY");
  console.log("total tests:", total);
  console.log("passed:", passed);
  console.log("failed:", failed);
  console.log("skipped:", skipped);

  if (failed > 0) {
    console.log("\nFailing tests:");
    for (const r of rows) {
      if (r.outcome !== "fail") continue;
      console.log(`  - ${r.name}`);
      if (r.errorCode) console.log(`      code: ${r.errorCode}`);
      if (r.errorMessage) console.log(`      message: ${r.errorMessage}`);
    }
  }
}

async function main() {
  const setupErr = await loadBookingTestCtx();
  if (setupErr) {
    console.error("SETUP FAILED:", setupErr);
    process.exit(1);
  }

  const repeat = parseRepeatCount();
  let aggregated: TestResultRow[] = [];

  for (let i = 0; i < repeat; i++) {
    if (repeat > 1) {
      console.log(`\n########## SUITE RUN ${i + 1} / ${repeat} ##########`);
    }

    await deleteNqTestPrefixedBookings();
    const runPrefix = makeRunClientPrefix();

    const batch = await runAllTests(runPrefix);
    aggregated = batch;

    await deleteNqTestPrefixedBookings();

    const fails = batch.filter((r) => r.outcome === "fail").length;
    if (fails > 0) break;
  }

  if (repeat > 1) {
    const allRunsOk = !aggregated.some((r) => r.outcome === "fail");
    console.log(
      allRunsOk
        ? `\nCompleted ${repeat} full suite runs (each: cleanup → tests → cleanup).`
        : `\nStopped after failure during repeat=${repeat} (summary = last completed run).`,
    );
  }

  printSummary(aggregated);

  const anyFail = aggregated.some((r) => r.outcome === "fail");
  if (anyFail) {
    console.log("\n========================");
    console.log("Some tests failed (see above).");
    process.exit(1);
  }

  console.log("\n✅ ALL TESTS PASSED");
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
