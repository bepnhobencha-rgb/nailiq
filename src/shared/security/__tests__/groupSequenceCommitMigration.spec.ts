import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260830005555_add_atomic_group_sequence_commit.sql",
  ),
  "utf8",
);

describe("group x multi-service Phase 2B1 database boundary", () => {
  it("adds one atomic create and one read-only replay contract", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.create_public_group_booking_sequences",
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.replay_public_group_booking_sequences",
    );
    expect(migration).toContain("group-sequence-idempotency:");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("FOR SHARE");
    expect(migration).toContain("'idempotent', true");
  });

  it("consumes only the organizer OTP in the booking transaction", () => {
    expect(migration).toContain("consumed_by_booking_id = v_organizer_booking_id");
    expect(migration).toContain("v_member_index = 0 AND v_phone_otp_enabled");
    expect(migration).not.toMatch(/consumed_by_booking_id\s*=\s*v_booking_id/i);
    expect(migration).toContain("group sequence OTP consumption invariant failed");
  });

  it("persists every booking, segment, and add-on inside one exception boundary", () => {
    const writeBoundary = migration.slice(
      migration.indexOf("  BEGIN\n    FOR v_member_quote IN"),
      migration.indexOf("END;\n$group_sequence_create$;"),
    );
    expect(writeBoundary).toContain("INSERT INTO public.bookings");
    expect(writeBoundary).toContain("INSERT INTO public.booking_service_segments");
    expect(writeBoundary).toContain("INSERT INTO public.booking_addons");
    expect(writeBoundary).toContain("WHEN exclusion_violation");
    expect(writeBoundary).toContain("WHEN unique_violation");
    expect(writeBoundary).toContain("WHEN check_violation OR foreign_key_violation");
  });

  it("keeps runtime unavailable until the management lifecycle exists", () => {
    expect(migration).toContain("'management_lifecycle_ready', false");
    expect(migration).toContain("'ready', false");
    expect(migration).toContain("Phase 2B1 must remain runtime disabled");
  });

  it("keeps privileged functions service-role-only and provider-free", () => {
    for (const signature of [
      "create_public_group_booking_sequences(jsonb)",
      "replay_public_group_booking_sequences(jsonb)",
    ]) {
      const escaped = signature.replace(/[()]/g, "\\$&");
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${escaped}\\s+FROM PUBLIC, anon, authenticated;[\\s\\S]{0,120}?GRANT EXECUTE ON FUNCTION public\\.${escaped}\\s+TO service_role;`,
          "i",
        ),
      );
    }
    expect(migration).not.toMatch(/https?:\/\//i);
    expect(migration).not.toMatch(/net\.http|twilio|resend|stripe/i);
    expect(migration).not.toMatch(/square[_a-z]*\s*\(/i);
  });
});
