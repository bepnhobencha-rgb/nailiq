import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260728224432_add_reversible_salon_client_identity_merge.sql",
);
const revokeOrderFix = read(
  "supabase/migrations/20260729002306_fix_identity_merge_revoke_order.sql",
);
const action = read("src/shared/dashboard/clientIdentityReviewAction.ts");
const reports = read("src/shared/dashboard/loadSalonReports.ts");
const ownerHome = read("src/shared/dashboard/loadOwnerHomeDashboardAction.ts");
const reportsPage = read("src/app/dashboard/[slug]/insights/page.tsx");
const nextConfig = read("next.config.ts");
const legacyReportsPagePath = resolve(
  process.cwd(),
  "src/app/dashboard/[slug]/reports/page.tsx",
);
const reportsPanel = read("src/components/dashboard/ReportsPanel.tsx");
const reportsRoute = read("src/app/api/dashboard/insights/route.ts");
const legacyReportsRoute = read("src/app/api/dashboard/reports/route.ts");

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

  it("deactivates an alias before restoring bookings so the trigger cannot reapply it", () => {
    const deactivateAt = revokeOrderFix.indexOf("SET active = false");
    const restoreAt = revokeOrderFix.indexOf(
      "SET client_profile_id = v_alias.alias_profile_id",
    );
    expect(deactivateAt).toBeGreaterThan(0);
    expect(restoreAt).toBeGreaterThan(deactivateAt);
    expect(revokeOrderFix).toContain(
      "FROM PUBLIC, anon, authenticated",
    );
    expect(revokeOrderFix).toContain("TO service_role");
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

  it("renders Reports without a client hydration boundary", () => {
    expect(reportsPage).toContain("loadSalonReports(slug, range)");
    expect(reportsPage).toContain("searchParams");
    expect(reportsPage).not.toContain("initialResult=");
    expect(reportsPanel).not.toContain("initialResult:");
    expect(reportsPanel).not.toContain('"use client"');
    expect(reportsPanel).not.toMatch(/\buse(State|Effect|Memo|Ref)\b/);
    expect(reportsPanel).not.toContain("loadSalonReports(");
    expect(reportsPanel).toContain("/insights?range=${r}");
    expect(existsSync(legacyReportsPagePath)).toBe(false);
    expect(nextConfig).toContain('source: "/dashboard/:slug/reports"');
    expect(nextConfig).toContain('destination: "/dashboard/:slug/insights"');
    expect(reports).toContain('import "server-only"');
    expect(reportsRoute).toContain("await loadSalonReports(slug, range)");
    expect(reportsRoute).toContain('"Cache-Control": "no-store"');
    expect(legacyReportsRoute).toContain(
      'export { GET } from "@/app/api/dashboard/insights/route"',
    );
  });
});
