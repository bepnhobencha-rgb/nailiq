import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260724100000_explicit_client_profile_policy.sql",
);
const proof = read("scripts/security/check-client-profile-boundary.sql");
const rollback = read(
  "scripts/security/rehearse-client-profile-rollback.sql",
);

describe("client_profiles boundary", () => {
  it("removes table and column grants while preserving the service role", () => {
    expect(migration).toContain(
      "REVOKE ALL PRIVILEGES ON TABLE public.client_profiles",
    );
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES \(\s*id,\s*phone,/,
    );
    expect(migration).toContain(
      "GRANT ALL PRIVILEGES ON TABLE public.client_profiles TO service_role",
    );
    expect(proof).toContain("has_any_column_privilege");
  });

  it("adds exactly one restrictive false policy", () => {
    expect(migration).toContain("AS RESTRICTIVE FOR ALL");
    expect(migration).toContain("USING (false) WITH CHECK (false)");
    expect(proof).toContain("v_policy_count <> 1");
    expect(proof).toContain("AND NOT polpermissive");
    expect(proof).toContain("cardinality(polroles) = 2");
  });

  it("rehearses the exact legacy table and column ACL then rolls back", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("ROLLBACK;");
    expect(rollback).toContain(
      "GRANT DELETE, TRUNCATE, REFERENCES, TRIGGER",
    );
    expect(rollback).toContain("GRANT INSERT (");
    expect(rollback).toContain("GRANT UPDATE (");
    expect(rollback).toContain("\\ir check-client-profile-boundary.sql");
  });

  it("keeps runtime table access on service-role clients or narrow RPCs", () => {
    const serviceRole = read("src/shared/lib/supabase/serviceRole.ts");
    const looseDb = read("src/shared/integrations/square/looseDb.ts");
    const profile360 = read(
      "src/shared/dashboard/loadClientProfile360Action.ts",
    );
    const publicBooking = read(
      "src/shared/booking/submitPublicBooking.ts",
    );

    expect(serviceRole).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(looseDb).toContain("return createServiceRoleClient()");
    expect(profile360).toContain("createServiceRoleClient");
    expect(publicBooking).toContain('"get_booking_client_snapshot"');
  });

  it("keeps receptionist VIP enrichment behind the service-role boundary", () => {
    const loader = read(
      "src/shared/dashboard/loadReceptionistCenterData.ts",
    );

    expect(loader).toContain("const profileDb = createServiceRoleClient()");
    expect(loader).toContain(
      'profileDb\n      .from("client_profiles")',
    );
    expect(loader).not.toContain(
      'supabase\n      .from("client_profiles")\n      .select("phone, is_vip"',
    );
  });

  it("updates the blank-database parity tripwire", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("policies: 154");
    expect(parity).toContain(
      "const GRANTS = { anon: 57, authenticated: 64, service_role: 110 }",
    );
  });
});
