import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

const migration = read(
  "supabase/migrations/20260724103000_finalize_public_booking_profile.sql",
);
const proof = read(
  "scripts/security/check-public-booking-profile-finalization.sql",
);
const rollback = read(
  "scripts/security/rehearse-public-booking-profile-finalization-rollback.sql",
);
const individual = read("src/shared/booking/submitPublicBooking.ts");
const group = read("src/shared/booking/submitGroupBooking.ts");

describe("public booking profile finalization boundary", () => {
  it("binds profile writes to a recent booking and matching OTP identity", () => {
    expect(migration).toContain("b.created_at >= v_now - interval '10 minutes'");
    expect(migration).toContain("s.salon_id = v_booking.salon_id");
    expect(migration).toContain("public.canonical_phone(s.phone)");
    expect(migration).toContain("public.canonical_phone(v_booking.client_phone)");
    expect(migration).toContain("cp.id = v_booking.client_profile_id");
  });

  it("atomically records OTP evidence and consumes the session", () => {
    expect(migration).toContain("phone_verified_at = CASE");
    expect(migration).toContain("verification_method = 'otp'");
    expect(migration).toContain("otp_session_id = v_session.id");
    expect(migration).toContain("SET consumed_at = coalesce(consumed_at, v_now)");
  });

  it("exposes only the intended anonymous capability", () => {
    expect(migration).toMatch(/SECURITY DEFINER/i);
    expect(migration).toContain("SET search_path TO 'public'");
    expect(migration).toContain(
      "FROM PUBLIC, anon, authenticated",
    );
    expect(migration).toContain("TO anon, service_role");
    expect(proof).toContain(
      "has_function_privilege('authenticated', v_oid, 'EXECUTE')",
    );
  });

  it("has an explicit rollback rehearsal", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain(
      "DROP FUNCTION public.finalize_public_booking_profile(uuid, uuid, boolean)",
    );
    expect(rollback).toContain("rollback left finalize_public_booking_profile installed");
    expect(rollback).toContain("ROLLBACK;");
    expect(rollback).toContain("\\ir check-public-booking-profile-finalization.sql");
  });

  it("routes both individual and group OTP completion through the RPC", () => {
    expect(individual).toContain('"finalize_public_booking_profile"');
    expect(group).toContain('"finalize_public_booking_profile"');
    expect(individual).not.toContain('.from("client_profiles")');
    expect(
      individual.match(/\/api\/booking-otp\/consume-session/g),
    ).toHaveLength(1);
    expect(
      group.match(/\/api\/booking-otp\/consume-session/g),
    ).toHaveLength(1);
  });
});
