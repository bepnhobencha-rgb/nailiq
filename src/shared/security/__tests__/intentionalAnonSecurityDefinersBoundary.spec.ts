import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const proof = read(
  "scripts/security/check-intentional-anon-security-definers.sql",
);
const rationale = read(
  "docs/audit/INTENTIONAL-ANON-SECURITY-DEFINERS.md",
);

const intentionalDefiners = [
  "add_booking_addons",
  "check_group_slots_available",
  "create_public_booking",
  "create_public_waitlist_entry",
  "finalize_public_booking_profile",
  "get_booking_client_snapshot",
  "insert_group_bookings",
  "public_booking_occupancy_for_range",
  "public_resolve_domain",
  "validate_phone_otp_session",
] as const;

describe("intentional anonymous SECURITY DEFINER boundary", () => {
  it("keeps the production allowlist exact and documented", () => {
    expect(proof).toContain("IF v_actual_count <> 10");

    for (const functionName of intentionalDefiners) {
      expect(proof).toContain(`public.${functionName}`);
      expect(rationale).toContain(`\`${functionName}\``);
    }
  });

  it("proves ownership, search path, and least-privilege execution", () => {
    expect(proof).toContain("<> 'postgres'");
    expect(proof).toContain("search_path=public%");
    expect(proof).toContain("v_public_execute");
    expect(proof).toContain(
      "NOT has_function_privilege('anon', v_oid, 'EXECUTE')",
    );
    expect(proof).toContain(
      "has_function_privilege('authenticated', v_oid, 'EXECUTE')",
    );
    expect(proof).toContain(
      "NOT has_function_privilege('service_role', v_oid, 'EXECUTE')",
    );
  });

  it("pins public-input guards and sanitized return contracts", () => {
    const requiredFragments = [
      "cardinality(p_service_ids) > 8",
      "conflicting_members",
      "public-booking:phone:",
      "invalid_service_for_salon",
      "v_booking.otp_session_id = s.id",
      "b.created_at >= now() - interval ''10 minutes''",
      "v_group_size < 2 OR v_group_size > 20",
      "RETURNS TABLE(staff_id uuid",
      "d.domain = lower(p_host)",
      "s.expires_at > now()",
    ];

    for (const fragment of requiredFragments) {
      expect(proof).toContain(fragment);
    }
  });

  it("keeps direct anonymous access to protected source tables closed", () => {
    expect(proof).toContain(
      "has_table_privilege('anon', 'public.bookings', 'INSERT')",
    );
    expect(proof).toContain(
      "has_table_privilege('anon', 'public.client_profiles', 'SELECT')",
    );
    expect(proof).toContain(
      "has_table_privilege('anon', 'public.phone_otp_sessions', 'SELECT')",
    );
    expect(proof).toContain(
      "has_table_privilege('anon', 'public.salons', 'SELECT')",
    );
    expect(proof).toContain("bool_and(c.relrowsecurity)");
  });
});
