import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260728224432_add_reversible_salon_client_identity_merge.sql",
);
const action = read("src/shared/dashboard/clientIdentityReviewAction.ts");
const reports = read("src/shared/dashboard/loadSalonReportsAction.ts");
const ownerHome = read("src/shared/dashboard/loadOwnerHomeDashboardAction.ts");

describe("salon client identity merge boundary", () => {
  it("keeps global profiles intact and scopes every booking change to a salon", () => {
    expect(migration).not.toMatch(
      /UPDATE\s+public\.client_profiles\s+SET\s+deleted_at/i,
    );
    expect(migration).not.toMatch(/DELETE\s+FROM\s+public\.client_profiles/i);
    expect(migration).toContain("WHERE b.salon_id = p_salon_id");
    expect(migration).toContain(
      "REFERENCES public.client_profiles(id) ON DELETE RESTRICT",
    );
  });

  it("requires a real owner in both the server action and transaction", () => {
    expect(action).toContain('ctx.kind !== "member"');
    expect(action).toContain("isOwner(ctx.role)");
    expect(migration).toContain("sm.user_id = p_actor_user_id");
    expect(migration).toContain("sm.role = 'owner'");
  });

  it("keeps direct writes closed and privileged functions service-only", () => {
    expect(migration).toContain(
      "REVOKE ALL ON TABLE public.salon_client_identity_aliases",
    );
    expect(migration).toContain(
      "REVOKE ALL ON TABLE public.salon_client_identity_merge_events",
    );
    expect(migration).toContain(
      "GRANT SELECT ON TABLE public.salon_client_identity_aliases TO authenticated",
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.merge_salon_client_identity\([\s\S]*?FROM PUBLIC, anon, authenticated;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.merge_salon_client_identity\([\s\S]*?TO service_role;/,
    );
  });

  it("is reversible and preserves the customer's submitted phone", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.revoke_salon_client_identity_merge",
    );
    expect(migration).toContain(
      "SET client_profile_id = v_alias.alias_profile_id",
    );
    expect(migration).toContain(
      "booking's original client_phone remains unchanged",
    );
    expect(migration).not.toMatch(/SET\s+client_phone\s*=/i);
  });

  it("records immutable merge/revoke evidence", () => {
    expect(migration).toContain(
      "CREATE TABLE public.salon_client_identity_merge_events",
    );
    expect(migration).toContain(
      "action text NOT NULL CHECK (action IN ('merge', 'revoke'))",
    );
    expect(migration).not.toMatch(
      /ON public\.salon_client_identity_merge_events\s+FOR (UPDATE|DELETE)/i,
    );
  });

  it("keeps owner analytics on the reviewed canonical identity", () => {
    for (const source of [reports, ownerHome]) {
      expect(source).toContain("client_profile_id");
      expect(source).toContain("customerIdentityKey");
    }
    expect(reports).toContain("clientIdentities");
    expect(ownerHome).toContain("priorClientSet");
  });
});
