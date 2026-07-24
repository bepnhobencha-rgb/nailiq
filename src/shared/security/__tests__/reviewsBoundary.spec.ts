import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(file, "utf8");

const migration = read(
  "supabase/migrations/20260724173000_explicit_reviews_policy.sql",
);
const proof = read("scripts/security/check-reviews-boundary.sql");
const rollback = read("scripts/security/rehearse-reviews-rollback.sql");

describe("reviews boundary", () => {
  it("removes direct API grants while preserving service-role access", () => {
    expect(migration).toContain(
      "REVOKE ALL PRIVILEGES ON TABLE public.reviews",
    );
    expect(migration).toContain(
      "GRANT ALL PRIVILEGES ON TABLE public.reviews TO service_role",
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

  it("rehearses the exact legacy write-only ACL then rolls back", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("ROLLBACK;");
    expect(rollback).toContain(
      "GRANT ALL PRIVILEGES ON TABLE public.reviews",
    );
    expect(rollback).toContain("REVOKE SELECT ON TABLE public.reviews");
    expect(rollback).toContain("\\ir check-reviews-boundary.sql");
  });

  it("keeps public token flows and salon reads on validated server paths", () => {
    const page = read("src/app/reviews/[token]/page.tsx");
    const submit = read("src/shared/reviews/submitReviewAction.ts");
    const dashboard = read(
      "src/shared/dashboard/loadSalonReviewsAction.ts",
    );
    const request = read("src/shared/dashboard/sendReviewRequest.ts");

    expect(page).toContain("createServiceRoleClient()");
    expect(page).toContain('.eq("request_token", token)');
    expect(submit).toContain("createServiceRoleClient()");
    expect(submit).toContain('.eq("request_token", t)');
    expect(dashboard).toContain("isOwnerOrAdmin(resolved.role)");
    expect(dashboard).toContain("createServiceRoleClient()");
    expect(dashboard).toContain('.eq("salon_id", resolved.salon.id)');
    expect(request).toContain("createServiceRoleClient()");
  });

  it("updates blank-database parity tripwires", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("through 20260724173000");
    expect(parity).toContain("policies: 140");
    expect(parity).toContain(
      "const GRANTS = { anon: 57, authenticated: 60, service_role: 94 }",
    );
  });
});
