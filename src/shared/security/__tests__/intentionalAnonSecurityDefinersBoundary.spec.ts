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
const capacityAcl = read(
  "supabase/migrations/20260901204200_restrict_service_resource_capacity_authenticated_execute.sql",
);

const intentionalDefiners = [
  "add_booking_addons",
  "check_group_slots_available",
  "create_public_booking",
  "finalize_public_booking_profile",
  "get_booking_client_snapshot",
  "public_booking_capacity_for_range",
  "public_booking_occupancy_for_range",
  "public_resolve_domain",
  "public_salon_accepts_new_bookings",
  "validate_booking_otp_session",
  "validate_phone_otp_session",
] as const;

describe("intentional anonymous SECURITY DEFINER boundary", () => {
  it("keeps the candidate allowlist exact and documented", () => {
    expect(proof).toContain("IF v_actual_count <> 13");

    for (const functionName of intentionalDefiners) {
      expect(proof).toContain(`public.${functionName}`);
      expect(rationale).toContain(`\`${functionName}\``);
    }

    expect(capacityAcl).toContain("FROM PUBLIC, authenticated");
    expect(capacityAcl).toContain("TO anon, service_role");
  });

  it("keeps booking contact proof separate from SMS phone authority", () => {
    const bookingStart = proof.indexOf("'public.validate_booking_otp_session(uuid,uuid,text)'");
    const phoneStart = proof.indexOf("'public.validate_phone_otp_session(uuid,uuid,text)'");
    expect(bookingStart).toBeGreaterThan(-1);
    expect(phoneStart).toBeGreaterThan(bookingStart);
    const bookingGuard = proof.slice(bookingStart, phoneStart);
    const phoneGuard = proof.slice(phoneStart, proof.indexOf(") AS expected(signature"));
    for (const guard of [bookingGuard, phoneGuard]) {
      expect(guard).toContain("RETURNS boolean");
      expect(guard).toContain("s.id = p_session_id");
      expect(guard).toContain("s.salon_id = p_salon_id");
      expect(guard).toContain("s.phone = pg_catalog.regexp_replace");
      expect(guard).toContain("s.consumed_at IS NULL");
      expect(guard).toContain("s.consumed_by_booking_id IS NULL");
      expect(guard).toContain("s.expires_at > now()");
      expect(guard).not.toContain("legacy_unverified");
    }
    expect(bookingGuard).toContain("s.verified_channel IN (''sms'', ''email'', ''staff_attested'', ''demo'')");
    expect(phoneGuard).toContain("s.verified_channel = ''sms''");
    expect(phoneGuard).not.toContain("''email''");
    expect(phoneGuard).not.toContain("''staff_attested''");
    expect(phoneGuard).not.toContain("''demo''");
    const finalizerStart = proof.indexOf("'public.finalize_public_booking_profile(uuid,uuid,boolean)'");
    const finalizerGuard = proof.slice(finalizerStart, proof.indexOf("'public.get_booking_client_snapshot", finalizerStart));
    for (const fragment of [
      "s.verified_channel=''sms''",
      "(v_session.verified_channel=''sms'') IS DISTINCT FROM v_phone_owner",
      "public.lock_booking_crm_phones",
      "IF v_phone_owner THEN",
      "cp.id=v_profile_id",
      "public.canonical_phone(cp.phone)=v_phone",
      "crm_otp_expired_at_consumption",
      "v_session.consumed_at<v_session.expires_at",
    ]) expect(finalizerGuard).toContain(fragment);
  });

  it("pins the legacy wrapper to no phone proof and the new overload to exact SMS authority", () => {
    const wrapperStart = proof.indexOf("'public.create_public_booking(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text)'");
    const engineStart = proof.indexOf("'public.create_public_booking(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text,uuid)'");
    expect(wrapperStart).toBeGreaterThan(-1);
    expect(engineStart).toBeGreaterThan(wrapperStart);
    expect(proof.slice(wrapperStart, engineStart)).toContain("p_expected_pricing_fingerprint, NULL::uuid");
    const engineGuard = proof.slice(engineStart, proof.indexOf("'public.finalize_public_booking_profile", engineStart));
    for (const fragment of [
      "p_status IS DISTINCT FROM ''confirmed''",
      "public.resolve_public_booking_pricing",
      "'''pricing_changed'''",
      "public_booking_request_fingerprint",
      "p_expected_pricing_fingerprint",
      "public.booking_incentive_phone_ownership",
      "'''phone_verification_required'''",
      "clock_timestamp()",
      "consumed_by_booking_id",
    ]) expect(engineGuard).toContain(fragment);
  });

  it("proves ownership, search path, and least-privilege execution", () => {
    expect(proof).toContain("<> 'postgres'");
    expect(proof).toContain("WHERE setting = v_target.search_path_setting");
    expect(proof).not.toContain("setting LIKE");
    const expectedPaths = [...proof.matchAll(/'(public\.[^']+)',\s*'[vs]',\s*'(search_path=[^']+)'/g)]
      .map((match) => [match[1], match[2]]);
    expect(expectedPaths).toEqual([
      ["public.add_booking_addons(uuid,uuid[])", "search_path=public, pg_catalog"],
      ["public.check_group_slots_available(jsonb)", "search_path=public"],
      ["public.create_public_booking(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,integer,text,uuid,integer,text,uuid)", 'search_path=""'],
      ["public.create_public_booking(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text)", 'search_path=""'],
      ["public.create_public_booking(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text,uuid)", 'search_path=""'],
      ["public.finalize_public_booking_profile(uuid,uuid,boolean)", 'search_path=""'],
      ["public.get_booking_client_snapshot(uuid,text,uuid)", 'search_path=""'],
      ["public.public_booking_capacity_for_range(uuid,timestamp with time zone,timestamp with time zone)", 'search_path=""'],
      ["public.public_booking_occupancy_for_range(uuid,timestamp with time zone,timestamp with time zone)", "search_path=public"],
      ["public.public_resolve_domain(text)", "search_path=public"],
      ["public.public_salon_accepts_new_bookings(uuid)", 'search_path=""'],
      ["public.validate_booking_otp_session(uuid,uuid,text)", 'search_path=""'],
      ["public.validate_phone_otp_session(uuid,uuid,text)", 'search_path=""'],
    ]);
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

  it("requires exact booking-bound SMS proof before returning a customer snapshot", () => {
    const snapshotStart = proof.indexOf("'public.get_booking_client_snapshot(uuid,text,uuid)'");
    const snapshotGuard = proof.slice(snapshotStart, proof.indexOf("'public.public_booking_capacity_for_range", snapshotStart));
    for (const fragment of [
      "b.id = p_booking_id", "b.salon_id = p_salon_id",
      "s.id = b.otp_session_id", "s.verified_channel = ''sms''",
      "s.salon_id = b.salon_id", "s.consumed_by_booking_id = b.id",
      "s.consumed_at IS NOT NULL", "pg_catalog.isfinite(s.consumed_at)",
      "pg_catalog.isfinite(s.verified_at)", "pg_catalog.isfinite(s.expires_at)",
      "s.consumed_at >= s.verified_at", "s.consumed_at < s.expires_at",
      "s.consumed_at <= clock_timestamp()",
      "public.canonical_phone(s.phone) = public.canonical_phone(b.client_phone)",
      "public.canonical_phone(cp.phone) = public.canonical_phone(b.client_phone)",
    ]) expect(snapshotGuard).toContain(fragment);
    expect(snapshotGuard).not.toContain("''email''");
    expect(snapshotGuard).not.toContain("legacy_unverified");
  });

  it("pins public-input guards and sanitized return contracts", () => {
    const requiredFragments = [
      "cardinality(p_service_ids) > 8",
      "conflicting_members",
      "public-booking:phone:",
      "v_booking.otp_session_id=v_session.id",
      "b.created_at >= now() - interval ''10 minutes''",
      "RETURNS TABLE(staff_id uuid, resource_id uuid",
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
