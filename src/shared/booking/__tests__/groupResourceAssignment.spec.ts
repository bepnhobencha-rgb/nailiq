import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("group scheduling write boundary", () => {
  const migration = repoFile(
    "supabase/migrations/20260814040000_assign_group_booking_resources.sql",
  );

  it("assigns a required active resource only when resource mode is enabled", () => {
    expect(migration).toContain("coalesce(s.resources_enabled, false)");
    expect(migration).toContain("IF v_resources_enabled THEN");
    expect(migration).toContain("r.status = 'active'");
    expect(migration).toContain("r.deleted_at IS NULL");
    expect(migration).toMatch(
      /salon_id, staff_id, service_id, resource_id, client_name/,
    );
    expect(migration).toMatch(
      /IF v_resource_id IS NULL THEN[\s\S]*?RAISE EXCEPTION 'slot_conflict' USING ERRCODE = '23P01'/,
    );
    expect(migration).toContain("v_resource_id := NULL");
  });

  it("uses the canonical individual-booking lock namespaces and occupancy rules", () => {
    const individualBoundary = repoFile(
      "supabase/migrations/20260801122337_ensure_public_booking_resource_autoassign_replay.sql",
    );

    for (const lockNamespace of ["chr(255)", "chr(254)"]) {
      expect(individualBoundary).toContain(lockNamespace);
      expect(migration).toContain(lockNamespace);
    }
    expect(migration).toContain(
      "b.status NOT IN ('cancelled', 'waiting', 'no_show')",
    );
    expect(migration).toContain("b.start_time_utc < v_end");
    expect(migration).toContain("b.end_time_utc > v_start");
    expect(migration).toContain("WHEN exclusion_violation THEN");
    expect(migration).not.toMatch(
      /IF v_resource_id IS NULL THEN\s+RETURN jsonb_build_object/,
    );
  });

  it("keeps the shared group inserter private while both public and controlled paths use it", () => {
    const publicBoundary = repoFile(
      "supabase/migrations/20260810082707_enforce_group_booking_opening_hours.sql",
    );
    const controlledBoundary = repoFile(
      "supabase/migrations/20260810104500_add_controlled_after_hours_group_insert.sql",
    );

    expect(publicBoundary).toContain(
      "public.insert_group_bookings_unlimited(v_sanitized)",
    );
    expect(controlledBoundary).toContain(
      "public.insert_group_bookings_unlimited(p_bookings)",
    );
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.insert_group_bookings_unlimited(jsonb)",
    );
    expect(migration).toContain("FROM PUBLIC, anon, authenticated");
    expect(migration).toContain("TO service_role");
  });

  it("keeps every application group path on the shared time, conflict and hours policies", () => {
    const submit = repoFile("src/shared/booking/submitGroupBooking.ts");

    expect(submit).toContain("salonWallTimeToUtcIso");
    expect(submit).toContain("checkBookingConflict");
    expect(submit).toContain("checkGroupWithinOpeningHours");
    expect(submit).toContain('supabase.rpc("insert_group_bookings"');
    expect(submit).toContain("trustedExecution.insertGroupBookings(payload)");
  });
});
