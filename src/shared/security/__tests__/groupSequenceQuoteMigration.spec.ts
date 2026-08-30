import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260829231142_add_atomic_group_booking_sequences.sql",
  ),
  "utf8",
);

describe("group x multi-service Phase 2A database boundary", () => {
  it("lands default-off and keeps commit readiness false", () => {
    expect(migration).toMatch(
      /feature_group_multi_service_booking'[\s\S]{0,160}?false/i,
    );
    expect(migration).toContain("'atomic_commit_ready', false");
    expect(migration).toContain("'ready', false");
    expect(migration).toContain("group_multi_service_booking_enabled");
    expect(migration).toContain("'salon_enabled', coalesce(v_salon_enabled, false)");
    expect(migration).toContain(
      "'public.create_public_group_booking_sequences(jsonb)'",
    );
    expect(migration).toContain("Phase 2A must not expose group sequence commit");
  });

  it("requires explicit salon-owned resource topology for sit-together", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS adjacency_group text");
    expect(migration).toContain("salon_resources_adjacency_group_check");
    expect(migration).toContain("v_distinct_resources <> v_member_count");
    expect(migration).toContain("v_adjacency_groups <> 1");
    expect(migration).toContain("'seat_together_unproven'");
  });

  it("quotes every member while rejecting shared staff/resource collisions", () => {
    expect(migration).toContain("resolve_booking_sequence_pricing_and_schedule(");
    expect(migration).toContain("'group_slot_conflict'");
    expect(migration).toContain("resolved_staff_id");
    expect(migration).toContain("resolved_resource_id");
    expect(migration).toContain("pg_catalog.tstzrange(");
    expect(migration).toContain("too_many_service_lines");
  });

  it("does not copy guest identity or authorize an individual discount", () => {
    expect(migration).toContain(
      "'email', CASE WHEN v_member_index = 0 THEN v_organizer_email ELSE NULL END",
    );
    expect(migration).toContain(
      "'apply_email_discount', v_member_index = 0 AND v_apply_email_discount",
    );
    expect(migration).toContain("'code', 'organizer_mismatch'");
    expect(migration).not.toMatch(/resolve_client_profile\s*\(/i);
  });

  it("exposes all new functions only to service_role with a pinned search path", () => {
    for (const signature of [
      "load_public_group_sequence_readiness(uuid)",
      "resolve_public_group_sequence_quote(jsonb, boolean)",
      "quote_public_group_booking_sequences(jsonb)",
    ]) {
      const escaped = signature.replace(/[()]/g, "\\$&").replace(", ", ",\\s*");
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${escaped}\\s+FROM PUBLIC, anon, authenticated;[\\s\\S]{0,120}?GRANT EXECUTE ON FUNCTION public\\.${escaped}\\s+TO service_role;`,
          "i",
        ),
      );
    }
    expect(migration.match(/SECURITY DEFINER/g)?.length).toBeGreaterThanOrEqual(3);
    expect(migration.match(/SET search_path TO ''/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("contains no booking/payment/provider/notification write path", () => {
    expect(migration).not.toMatch(/INSERT\s+INTO\s+public\.bookings/i);
    expect(migration).not.toMatch(/UPDATE\s+public\.bookings/i);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+public\.bookings/i);
    expect(migration).not.toMatch(/consume_phone_otp|twilio|resend|square|stripe/i);
    expect(migration).not.toMatch(/https?:\/\//i);
  });
});
