import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260724033000_restrict_server_only_customer_rpcs.sql",
  ),
  "utf8",
);

const rollback = readFileSync(
  resolve(
    process.cwd(),
    "scripts/security/rehearse-server-only-customer-rpc-rollback.sql",
  ),
  "utf8",
);

const serverOnlyRpcs = [
  "cancel_booking_as_customer",
  "claim_party_slot",
  "claim_waitlist_slot",
  "confirm_booking_as_customer",
  "confirm_party_member",
  "decline_party_member",
  "reschedule_booking_as_customer",
  "update_party_claim_details",
] as const;

describe("server-only customer RPC boundary", () => {
  it("revokes direct browser execution and preserves service-role execution", () => {
    for (const rpc of serverOnlyRpcs) {
      expect(migration).toContain(`public.${rpc}`);
      expect(migration).toContain(`'public.${rpc}`);
      expect(rollback).toContain(`public.${rpc}`);
      expect(rollback).toContain(`'public.${rpc}`);
    }

    expect(migration).toMatch(/FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/TO service_role/);
    expect(migration).toMatch(
      /has_function_privilege\('anon', v_oid, 'EXECUTE'\)/,
    );
    expect(migration).toMatch(
      /has_function_privilege\('authenticated', v_oid, 'EXECUTE'\)/,
    );
  });

  it("keeps the exact rollback transaction-scoped and rechecks hardening", () => {
    expect(rollback).toMatch(/BEGIN;/);
    expect(rollback).toMatch(/TO PUBLIC, anon, authenticated/);
    expect(rollback).toMatch(/ROLLBACK;/);
    expect(rollback).toContain(
      "\\ir check-server-only-customer-rpc-grants.sql",
    );
  });

  it("routes every hardened RPC through a service-role server boundary", () => {
    const delegatedRoutes = [
      "src/app/api/booking/cancel-action/route.ts",
      "src/app/api/booking/reschedule-action/route.ts",
      "src/app/api/booking/confirm-action/route.ts",
    ].map((file) => readFileSync(resolve(process.cwd(), file), "utf8"));
    const sources = [
      "src/shared/booking/groupMemberRsvpActions.ts",
      "src/shared/booking/partyLinkActions.ts",
      "src/shared/booking/waitlistClaim.ts",
    ].map((file) =>
      readFileSync(resolve(process.cwd(), file), "utf8"),
    );

    for (const source of sources) {
      expect(source).toContain("createServiceRoleClient");
    }
    expect(delegatedRoutes[0]).toContain("BookingWithManagementCapability");
    expect(delegatedRoutes[1]).toContain("BookingWithManagementCapability");
    expect(delegatedRoutes[2]).toContain("bookingManagementCapabilities");
    const managementCapabilities = readFileSync(
      resolve(
        process.cwd(),
        "src/shared/booking/bookingManagementCapabilities.ts",
      ),
      "utf8",
    );
    expect(managementCapabilities).toContain("createServiceRoleClient");

    const combined = [
      ...sources,
      ...delegatedRoutes,
      managementCapabilities,
    ].join("\n");
    for (const rpc of ["claim_party_slot", "update_party_claim_details"]) {
      expect(combined).toContain(`"${rpc}"`);
    }
    expect(combined).toContain('"claim_waitlist_with_management_capability"');
    expect(combined).toContain('"confirm_booking_with_management_capability"');
    expect(combined).toContain('"cancel_booking_with_management_capability"');
    expect(combined).toContain('"reschedule_booking_with_management_capability"');
  });
});
