import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260724080000_deny_direct_notification_automation_access.sql",
);
const proof = read(
  "scripts/security/check-notification-automation-boundary.sql",
);
const rollback = read(
  "scripts/security/rehearse-notification-automation-rollback.sql",
);

const tables = [
  "campaign_schedules",
  "notification_templates",
  "reoptin_sends",
  "winback_suggestions",
];

describe("notification-automation boundary", () => {
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

  it("rehearses the exact legacy grants inside a rollback", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("ROLLBACK;");
    expect(rollback.match(/GRANT ALL PRIVILEGES ON TABLE/g)).toHaveLength(4);
    expect(rollback).toContain(
      "\\ir check-notification-automation-boundary.sql",
    );
  });

  it("keeps every direct table access path on a service-role client", () => {
    const looseDb = read(
      "src/shared/integrations/square/looseDb.ts",
    );
    const schedules = read("src/shared/reoptin/campaignSchedule.ts");
    const reoptin = read("src/shared/reoptin/reoptinCampaign.ts");
    const rebook = read("src/shared/winback/agentRebook.ts");
    const winback = read("src/shared/winback/agentWinback.ts");
    const reactivationDraft = read(
      "src/shared/ai/createReactivationCampaignDraft.ts",
    );
    const undo = read("src/shared/ai/undoAiAction.ts");
    const activity = read(
      "src/shared/dashboard/loadActivityFeedAction.ts",
    );
    const edgeFunction = read(
      "supabase/functions/reschedule-sms/index.ts",
    );

    expect(looseDb).toContain(
      "return createServiceRoleClient() as unknown as LooseDb",
    );
    for (const source of [schedules, reoptin, reactivationDraft, undo, activity]) {
      expect(source).toContain("createServiceRoleClient");
    }
    expect(rebook).toContain("createReactivationCampaignDraft");
    expect(winback).toContain("createReactivationCampaignDraft");
    expect(edgeFunction).toContain(
      "createClient(SUPABASE_URL, SERVICE_ROLE_KEY",
    );
  });

  it("updates the blank-database parity tripwire", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("policies: 209");
    expect(parity).toContain(
      "const GRANTS = { anon: 56, authenticated: 78, service_role: 180 }",
    );
  });
});
