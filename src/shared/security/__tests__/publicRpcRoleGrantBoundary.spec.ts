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
