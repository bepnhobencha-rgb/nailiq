import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(file, "utf8");

const migration = read(
  "supabase/migrations/20260724170000_explicit_payment_disputes_policy.sql",
);
const proof = read("scripts/security/check-payment-disputes-boundary.sql");
const rollback = read(
  "scripts/security/rehearse-payment-disputes-rollback.sql",
);

describe("payment_disputes boundary", () => {
  it("removes direct API grants while preserving service-role access", () => {
    expect(migration).toContain(
      "REVOKE ALL PRIVILEGES ON TABLE public.payment_disputes",
    );
    expect(migration).toContain(
      "GRANT ALL PRIVILEGES ON TABLE public.payment_disputes TO service_role",
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

  it("rehearses the exact service-only legacy ACL then rolls back", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("ROLLBACK;");
    expect(rollback).toContain(
      "GRANT ALL PRIVILEGES ON TABLE public.payment_disputes TO service_role",
    );
    expect(rollback).toContain("\\ir check-payment-disputes-boundary.sql");
  });

  it("keeps webhook writes and owner/admin dashboard reads server-side", () => {
    const stripe = read("src/app/api/stripe/webhook/route.ts");
    const square = read("src/app/api/webhooks/square/route.ts");
    const dashboard = read("src/shared/dashboard/loadDisputesAction.ts");

    expect(stripe).toContain("createServiceRoleClient()");
    expect(stripe).toContain('.from("payment_disputes" as never)');
    expect(square).toContain("createServiceRoleClient()");
    expect(square).toContain('.from("payment_disputes" as never)');
    expect(dashboard).toContain("requireOwnerOrAdmin(slug)");
    expect(dashboard).toContain("createServiceRoleClient()");
    expect(dashboard).toContain('.eq("salon_id" as never, salonId)');
  });

  it("updates blank-database parity tripwires", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("through 20260729100000");
    expect(parity).toContain("policies: 151");
    expect(parity).toContain(
      "const GRANTS = { anon: 57, authenticated: 64, service_role: 106 }",
    );
  });
});
