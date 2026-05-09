import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { cleanupTestSalon, seedTestSalon } from "./helpers/db";

/**
 * DB-level conflict guard test (Task #032 — PRE GO-LIVE BLOCKER verify).
 *
 * Verifies that the `bookings_no_overlap` GIST EXCLUDE constraint
 * (defined in migration `20260430230000_bookings_no_overlap_gist.sql`)
 * rejects a concurrent double-booking attempt on the same staff at
 * the same time slot. The app-level `checkBookingConflict` is early
 * UX feedback only; this test bypasses it and inserts directly with
 * the service-role client to prove the DB itself is the primary
 * guard. Postgres returns SQLSTATE `23P01` (exclusion_violation),
 * which surfaces as `error.code === '23P01'` from supabase-js.
 *
 * Race scope: this fires two `INSERT` calls in parallel via
 * `Promise.all`. The DB serializes them through the GIST exclusion
 * lock — exactly one succeeds; the other fails with 23P01. App
 * server-action callers map this to a `slot_conflict` error.
 */
test.describe("Booking conflict — DB-level constraint", () => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  test.skip(
    !supabaseUrl.trim() || !serviceKey.trim(),
    "Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (e.g. .env.local).",
  );

  const supabase = createClient(supabaseUrl, serviceKey);
  let salonId: string;
  let serviceId: string;
  let staffId: string;

  test.beforeAll(async () => {
    // Seed a fresh salon + service + staff (the standard helper).
    const seed = await seedTestSalon({
      phone: "15558881100",
      slug: "e2e-conflict-salon",
      name: "E2E Conflict Salon",
    });
    salonId = seed.salonId;

    const { data: svc } = await supabase
      .from("services")
      .select("id")
      .eq("salon_id", salonId)
      .limit(1)
      .maybeSingle();
    if (!svc?.id) throw new Error("conflict-spec: seed service missing");
    serviceId = String(svc.id);

    const { data: stf } = await supabase
      .from("staff")
      .select("id")
      .eq("salon_id", salonId)
      .limit(1)
      .maybeSingle();
    if (!stf?.id) throw new Error("conflict-spec: seed staff missing");
    staffId = String(stf.id);
  });

  test.afterAll(async () => {
    await cleanupTestSalon("e2e-conflict-salon");
  });

  test("concurrent overlapping bookings on same staff fail with DB-level constraint", async () => {
    // Two bookings on the same staff with **overlapping** but
    // non-identical start times so the GIST EXCLUDE (`bookings_no_overlap`)
    // is the relevant guard — the UNIQUE on (salon_id, staff_id,
    // start_time_utc) only catches identical-instant races, while the
    // GIST catches the broader interval-overlap case that's the actual
    // operational hazard (booking A 14:00–15:00 vs booking B 14:30–15:30).
    const today = new Date();
    today.setUTCHours(14, 0, 0, 0);
    const startA = today.toISOString();
    const endA = new Date(today.getTime() + 60 * 60_000).toISOString();
    const startB = new Date(today.getTime() + 30 * 60_000).toISOString();
    const endB = new Date(today.getTime() + 90 * 60_000).toISOString();

    const common = {
      salon_id: salonId,
      service_id: serviceId,
      staff_id: staffId,
      client_phone: "15558887777",
      status: "confirmed" as const,
      source: "appointment" as const,
    };

    const [first, second] = await Promise.all([
      supabase
        .from("bookings")
        .insert({
          ...common,
          client_name: "ConflictRacerA",
          start_time_utc: startA,
          end_time_utc: endA,
        })
        .select("id")
        .maybeSingle(),
      supabase
        .from("bookings")
        .insert({
          ...common,
          client_name: "ConflictRacerB",
          start_time_utc: startB,
          end_time_utc: endB,
        })
        .select("id")
        .maybeSingle(),
    ]);

    const successes = [first, second].filter((r) => r.error === null && r.data?.id);
    const failures = [first, second].filter((r) => r.error !== null);

    expect(successes.length, "exactly one of the overlapping bookings must succeed").toBe(1);
    expect(failures.length, "exactly one must fail at the DB layer").toBe(1);

    const failure = failures[0]!;
    // Accept either DB-level conflict code:
    //   - `23P01` → exclusion_violation (the GIST `bookings_no_overlap`)
    //   - `23505` → unique_violation (the unique-on-start triple — only
    //     fires when starts are identical, which can happen if both
    //     payloads are coerced; defense in depth).
    // The point of this test is to prove the **DB itself** rejects
    // the conflict; both codes satisfy that contract.
    const code = failure.error?.code ?? "";
    expect(
      ["23P01", "23505"],
      `DB must reject overlapping bookings (got ${code}: ${failure.error?.message ?? ""})`,
    ).toContain(code);

    const survivor = successes[0]!.data!;
    await supabase.from("bookings").delete().eq("id", survivor.id);
  });
});
