import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260724093000_explicit_client_intelligence_policies.sql",
);
const proof = read(
  "scripts/security/check-client-intelligence-boundary.sql",
);
const rollback = read(
  "scripts/security/rehearse-client-intelligence-rollback.sql",
);

const tables = [
  "client_ai_summaries",
  "salon_clients",
  "salon_client_names",
  "salon_client_spend",
];

describe("client-intelligence boundary", () => {
  it("closes direct API grants and preserves service-role access", () => {
    for (const table of tables) {
      expect(migration).toContain(`public.${table}`);
      expect(proof).toContain(`'${table}'`);
    }
    expect(migration.match(/REVOKE ALL PRIVILEGES/g)).toHaveLength(4);
    expect(migration.match(/GRANT ALL PRIVILEGES/g)).toHaveLength(4);
    expect(proof).toMatch(
      /has_any_column_privilege\(\s*'authenticated'/,
    );
  });

  it("adds one restrictive false policy per table", () => {
    expect(migration.match(/AS RESTRICTIVE/g)).toHaveLength(4);
    expect(migration.match(/USING \(false\)/g)).toHaveLength(4);
    expect(migration.match(/WITH CHECK \(false\)/g)).toHaveLength(4);
    expect(proof).toContain("v_policy_count <> 1");
    expect(proof).toContain("AND NOT polpermissive");
  });

  it("rehearses the exact mixed legacy ACL and returns to the boundary", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("ROLLBACK;");
    expect(rollback).toContain(
      "v_table IN ('salon_client_names', 'salon_client_spend')",
    );
    expect(rollback).toContain(
      "\\ir check-client-intelligence-boundary.sql",
    );
  });

  it("keeps direct runtime access on service-role clients", () => {
    const looseDb = read("src/shared/integrations/square/looseDb.ts");
    const reoptin = read("src/shared/reoptin/reoptinCampaign.ts");
    const spendSync = read(
      "src/shared/integrations/square/spendSync.ts",
    );
    const name = read("src/shared/dashboard/salonClientName.ts");
    const vipCare = read("src/shared/ai/agentVipCare.ts");
    const topSpenders = read(
      "src/shared/dashboard/topSpendersActions.ts",
    );
    const rename = read("src/shared/dashboard/renameClientAction.ts");
    const profile360 = read(
      "src/shared/dashboard/loadClientProfile360Action.ts",
    );

    expect(looseDb).toContain("return createServiceRoleClient()");
    for (const source of [
      reoptin,
      name,
      topSpenders,
      rename,
      profile360,
    ]) {
      expect(source).toContain("createServiceRoleClient");
    }
    expect(spendSync).toContain("looseServiceClient");
    expect(vipCare).toContain("looseServiceClient");
  });

  it("keeps maintenance scripts on the service-role key", () => {
    for (const file of [
      "scripts/import-missing-june14-clients.ts",
      "scripts/enrich-hilite-studio-profiles.ts",
      "scripts/sync-hilite-studio-from-square.ts",
    ]) {
      expect(read(file)).toContain("SUPABASE_SERVICE_ROLE_KEY");
    }
  });

  it("never copies the Head Spa Square identity into Hi-Lite Studio", () => {
    const studioSync = read("scripts/sync-hilite-studio-from-square.ts");
    expect(studioSync).not.toContain("SOURCE_SALON_SLUG");
    expect(studioSync).not.toContain('eq("slug", "hilite-anaheim")');
    expect(studioSync).not.toContain('.from("square_integrations").upsert');
    expect(studioSync).toContain('.eq("salon_id", salonId)');
    expect(studioSync).toContain(
      "Configured Hi-Lite Studio location does not belong to its Square credential",
    );
  });

  it("updates the blank-database parity tripwire", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("policies: 208");
    expect(parity).toContain(
      "const GRANTS = { anon: 56, authenticated: 78, service_role: 180 }",
    );
  });
});
