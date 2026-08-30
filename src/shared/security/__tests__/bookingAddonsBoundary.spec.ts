import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(file, "utf8");

const migration = read(
  "supabase/migrations/20260724110000_explicit_booking_addons_policy.sql",
);
const proof = read("scripts/security/check-booking-addons-boundary.sql");
const rollback = read(
  "scripts/security/rehearse-booking-addons-rollback.sql",
);

describe("booking_addons boundary", () => {
  it("removes direct API grants while preserving service-role access", () => {
    expect(migration).toContain(
      "REVOKE ALL PRIVILEGES ON TABLE public.booking_addons",
    );
    expect(migration).toContain(
      "GRANT ALL PRIVILEGES ON TABLE public.booking_addons TO service_role",
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

  it("keeps the capability on anon and service_role only", () => {
    expect(proof).toContain(
      "'anon', 'public.add_booking_addons(uuid,uuid[])', 'EXECUTE'",
    );
    expect(proof).toContain(
      "'authenticated', 'public.add_booking_addons(uuid,uuid[])', 'EXECUTE'",
    );
    expect(proof).toContain(
      "'service_role', 'public.add_booking_addons(uuid,uuid[])', 'EXECUTE'",
    );
  });

  it("rehearses the exact legacy ACL then rolls back", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("ROLLBACK;");
    expect(rollback).toContain(
      "GRANT ALL PRIVILEGES ON TABLE public.booking_addons",
    );
    expect(rollback).toContain("\\ir check-booking-addons-boundary.sql");
  });

  it("routes dashboard table reads and writes through service-role clients", () => {
    const loader = read(
      "src/shared/dashboard/loadReceptionistCenterData.ts",
    );
    const actions = read("src/shared/dashboard/receptionistActions.ts");

    expect(loader).toContain('createServiceRoleClient()');
    expect(loader).toContain('.from("booking_addons")');
    expect(actions).toContain("const privilegedDb = createServiceRoleClient()");
    expect(actions).toContain('privilegedDb.rpc(\n        "add_booking_addons"');
    expect(actions).toContain("if (addonError)");
  });

  it("updates blank-database parity tripwires", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("policies: 209");
    expect(parity).toContain(
      "const GRANTS = { anon: 56, authenticated: 78, service_role: 180 }",
    );
  });
});
