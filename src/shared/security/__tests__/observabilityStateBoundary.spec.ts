import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260724073000_deny_direct_observability_state_access.sql",
);
const proof = read(
  "scripts/security/check-observability-state-boundary.sql",
);
const rollback = read(
  "scripts/security/rehearse-observability-state-rollback.sql",
);

const tables = [
  "ai_policy_decisions",
  "system_audit",
  "watchdog_alerts",
  "watchdog_state",
];

describe("observability-state boundary", () => {
  it("removes direct API grants and preserves service-role access", () => {
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

  it("keeps the audit trigger definer-only for API roles", () => {
    expect(proof).toContain("'public.log_system_audit()'::regprocedure");
    expect(proof).toContain("<> 'postgres'");
    expect(proof).toContain(
      "'authenticated', 'public.log_system_audit()', 'EXECUTE'",
    );
  });

  it("rehearses the exact legacy grants inside a rollback", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("ROLLBACK;");
    expect(rollback.match(/GRANT ALL PRIVILEGES ON TABLE/g)).toHaveLength(4);
    expect(rollback).toContain(
      "\\ir check-observability-state-boundary.sql",
    );
  });

  it("keeps every direct table access path on a service-role client", () => {
    const looseDb = read(
      "src/shared/integrations/square/looseDb.ts",
    );
    const watchdog = read("src/shared/watchdog/agentWatchdog.ts");
    const policy = read("src/shared/noshow/agentNoShowPolicy.ts");
    const override = read(
      "src/shared/dashboard/overrideNoShowPolicyAction.ts",
    );
    const activity = read(
      "src/shared/dashboard/loadActivityFeedAction.ts",
    );
    const attribution = read(
      "src/shared/dashboard/attributeAudit.ts",
    );

    expect(looseDb).toContain(
      "return createServiceRoleClient() as unknown as LooseDb",
    );
    for (const source of [
      watchdog,
      policy,
      override,
      activity,
      attribution,
    ]) {
      expect(source).toContain("createServiceRoleClient");
    }
    expect(activity).toContain('"use server"');
    expect(override).toContain('"use server"');
  });

  it("updates the blank-database parity tripwire", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("policies: 213");
    expect(parity).toContain(
      "const GRANTS = { anon: 56, authenticated: 78, service_role: 184 }",
    );
  });
});
