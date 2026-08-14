import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoFile = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

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

  it("preflights every tenant reference, time and idempotency key before locking", () => {
    const preflightStart = migration.indexOf(
      "FOR v_booking IN SELECT value FROM jsonb_array_elements(p_bookings)",
    );
    const firstLock = migration.indexOf("FOR v_lock_id IN");

    expect(preflightStart).toBeGreaterThan(-1);
    expect(firstLock).toBeGreaterThan(preflightStart);
    expect(migration).toContain("ELSIF v_row_salon_id <> v_salon_id THEN");
    expect(migration).toContain("sv.salon_id = v_salon_id");
    expect(migration).toContain("st.salon_id = v_salon_id");
    expect(migration).toContain("sv.deleted_at IS NULL");
    expect(migration).toContain("st.deleted_at IS NULL");
    expect(migration).toContain("st.status = 'active'");
    expect(migration).toContain("FROM public.staff_services configured");
    expect(migration).toContain("configured_staff.salon_id = v_salon_id");
    expect(migration).toContain("configured_service.salon_id = v_salon_id");
    expect(migration).toContain("FROM public.staff_services requested");
    expect(migration).toContain("requested.staff_id = v_staff_id");
    expect(migration).toContain("requested.service_id = v_service_id");
    expect(migration).toContain("v_end <= v_start");
    expect(migration).toContain("v_idempotency_key IS NULL");
    expect(migration).toContain(
      "A real group intentionally shares one UUID across every member",
    );
    expect(migration).not.toContain("v_seen_idempotency_keys");
  });

  it("hardens the private SECURITY DEFINER search path and proves its ACL", () => {
    expect(migration).toMatch(/SECURITY DEFINER\s+SET search_path TO ''/i);
    expect(migration).toContain("'search_path=\"\"'");
    expect(migration).toContain("p.prosecdef");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.insert_group_bookings_unlimited(jsonb)",
    );
    expect(migration).toContain("FROM PUBLIC, anon, authenticated");
    expect(migration).toContain("TO service_role");
  });

  it("keeps add-on tenant validation at the public/catalog boundaries without overclaiming private persistence", () => {
    const publicBoundary = repoFile(
      "supabase/migrations/20260810082707_enforce_group_booking_opening_hours.sql",
    );
    const baseline = repoFile(
      "supabase/migrations/20260723000000_folded_production_schema_baseline.sql",
    );

    expect(publicBoundary).toContain("s.id = v_addon_id");
    expect(publicBoundary).toContain("s.salon_id = v_salon_id");
    expect(publicBoundary).toContain("s.deleted_at IS NULL");
    expect(publicBoundary).toContain("s.is_addon");
    expect(baseline).toContain(
      "CREATE FUNCTION public.add_booking_addons(p_booking_id uuid, p_service_ids uuid[])",
    );
    expect(baseline).toContain("WHERE s.salon_id = v_salon_id");
    expect(migration).toContain(
      "Add-on IDs are deliberately not consumed or persisted by this private row",
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
    expect(submit).toContain('"insert_group_bookings" as never');
    expect(submit).toContain("p_otp_session_id: otpToConsume");
    expect(submit).toContain("trustedExecution.insertGroupBookings(payload)");
  });
});
