import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260724040000_restrict_public_rpc_role_grants.sql",
);
const rollback = read(
  "scripts/security/rehearse-public-rpc-role-grants-rollback.sql",
);
const currentProof = read("scripts/security/check-public-rpc-role-grants.sql");

const publicRpcs = [
  "add_booking_addons",
  "check_group_slots_available",
  "create_public_booking",
  "create_public_waitlist_entry",
  "get_booking_client_snapshot",
  "insert_group_bookings",
  "public_booking_occupancy_for_range",
  "public_resolve_domain",
  "salon_has_staff_services",
  "validate_phone_otp_session",
] as const;

describe("public RPC role grant boundary", () => {
  it("registers both current OTP boolean validators with anon/service-role access only", () => {
    for (const name of ["validate_phone_otp_session", "validate_booking_otp_session"]) {
      expect(currentProof).toContain(`('public.${name}(uuid,uuid,text)', true, false, true)`);
    }
    expect(currentProof).toContain("IF v_public_execute THEN");
    expect(currentProof).toContain("IS DISTINCT FROM v_target.allow_authenticated");
    expect(currentProof).toMatch(/IF has_function_privilege\('service_role', v_oid, 'EXECUTE'\)\s+IS DISTINCT FROM v_target.allow_service_role THEN/);
    // Keep the old rollback historically exact; the booking-only validator is
    // new and must never receive an invented pre-migration authenticated grant.
    expect(rollback).not.toContain("validate_booking_otp_session");
  });

  it("denies direct execution of private CRM and card authority helpers even to service role", () => {
    const privateSignatures = [
      "public.attach_desk_booking_client_profiles(uuid,uuid[],uuid)",
      "public.lock_booking_crm_phones(text[])",
      "public.update_party_booking_contact(uuid,uuid,text,text)",
      "public.square_card_booking_phone_authorized(uuid,uuid,jsonb)",
      "public.square_card_prior_attempts_terminal(uuid,uuid)",
      "public.bind_booking_existing_card_receipt(uuid,uuid,text,text,text)",
    ];
    const privateRows = [...currentProof.matchAll(/\('(public\.[^']+)', false, false, false\)/g)]
      .map((match) => match[1]);
    expect(privateRows).toEqual(privateSignatures);
    for (const signature of [
      "public.booking_incentive_phone_ownership(uuid,uuid,text,boolean)",
      "public.create_group_bookings_for_desk(uuid,jsonb,uuid,text,text,boolean,uuid,text,uuid)",
      "public.claim_party_slot_for_desk(text,uuid,text,text,boolean,uuid,uuid)",
      "public.replay_public_booking_with_deposit_payment(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text,uuid,uuid,text,uuid)",
    ]) expect(currentProof).toContain(`('${signature}', false, false, true)`);
    expect(currentProof).toContain("expected(signature, allow_anon, allow_authenticated, allow_service_role)");
  });
  it("removes inherited PUBLIC execute and proves the explicit role matrix", () => {
    for (const rpc of publicRpcs) {
      expect(migration).toContain(`public.${rpc}`);
      expect(migration).toContain(`'public.${rpc}`);
      expect(rollback).toContain(`public.${rpc}`);
      expect(rollback).toContain(`'public.${rpc}`);
    }

    expect(migration).toMatch(/FROM PUBLIC, anon, authenticated/g);
    expect(migration).toMatch(/grantee = 0[\s\S]*privilege_type = 'EXECUTE'/);
    expect(migration).toMatch(/TO service_role/g);
    expect(migration).toContain(
      "('public.salon_has_staff_services(uuid)', false, true)",
    );
    expect(migration).toContain(
      "('public.check_group_slots_available(jsonb)', true, true)",
    );
  });

  it("keeps the exact prior ACL restoration transaction-scoped", () => {
    expect(rollback).toMatch(/BEGIN;/);
    expect(rollback).toMatch(/ROLLBACK;/);
    expect(rollback).toContain("\\ir check-public-rpc-role-grants.sql");
    expect(rollback).toContain(
      "public.check_group_slots_available(jsonb)",
    );
    expect(rollback).toContain("TO PUBLIC, anon, authenticated");
  });

  it("uses a stateless anon client for public booking RPCs", () => {
    const publicClient = read("src/shared/lib/supabase/publicClient.ts");
    expect(publicClient).toContain("persistSession: false");
    expect(publicClient).toContain("autoRefreshToken: false");
    expect(publicClient).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");

    const publicBookingSources = [
      "src/shared/booking/submitPublicBooking.ts",
      "src/shared/booking/submitGroupBooking.ts",
      "src/shared/booking/submitPublicWaitlist.ts",
      "src/shared/booking/getAvailableTimeSlots.ts",
      "src/shared/booking/loadGroupDayTimeline.ts",
      "src/shared/booking/loadGroupSmartSchedule.ts",
      "src/shared/booking/checkGroupSlotsAvailable.ts",
    ].map(read);

    for (const source of publicBookingSources) {
      expect(source).toContain("createPublicClient");
    }
  });

  it("preserves authenticated and service-role callers that need them", () => {
    const groupProbe = read(
      "src/shared/booking/checkGroupSlotsAvailable.ts",
    );
    expect(groupProbe).toContain("createPublicClient");
    expect(groupProbe).toContain('"check_group_slots_available"');

    const setupActions = read("src/shared/dashboard/setupActions.ts");
    expect(setupActions).toContain('"salon_has_staff_services"');
    expect(setupActions).toContain(
      'createClient } from "@/shared/lib/supabase/server"',
    );

    const serviceRoleSources = [
      "src/shared/voiceai/toolExecutor.ts",
      "src/shared/dashboard/receptionistActions.ts",
      "src/app/api/booking/reschedule-slots/route.ts",
    ].map(read);
    for (const source of serviceRoleSources) {
      expect(source).toContain("createServiceRoleClient");
    }
  });
});
