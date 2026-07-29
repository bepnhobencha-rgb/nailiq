import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260724083000_explicit_internal_delivery_policies.sql",
);
const proof = read(
  "scripts/security/check-internal-delivery-boundary.sql",
);
const rollback = read(
  "scripts/security/rehearse-internal-delivery-rollback.sql",
);

const tables = [
  "owner_notification_log",
  "scheduled_notifications",
  "sms_agent_sessions",
];

describe("internal-delivery boundary", () => {
  it("keeps direct API grants closed and preserves service-role access", () => {
    for (const table of tables) {
      expect(migration).toContain(`public.${table}`);
      expect(proof).toContain(`'${table}'`);
    }
    expect(migration.match(/REVOKE ALL PRIVILEGES/g)).toHaveLength(3);
    expect(migration.match(/GRANT ALL PRIVILEGES/g)).toHaveLength(3);
    expect(proof).toMatch(
      /has_any_column_privilege\(\s*'authenticated'/,
    );
  });

  it("adds one restrictive false policy per table", () => {
    expect(migration.match(/AS RESTRICTIVE/g)).toHaveLength(3);
    expect(migration.match(/USING \(false\)/g)).toHaveLength(3);
    expect(migration.match(/WITH CHECK \(false\)/g)).toHaveLength(3);
    expect(proof).toContain("v_policy_count <> 1");
    expect(proof).toContain("AND NOT polpermissive");
  });

  it("rehearses the exact zero-policy service-only legacy shape", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("ROLLBACK;");
    expect(rollback).toContain(
      "EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid)",
    );
    expect(rollback).toContain(
      "\\ir check-internal-delivery-boundary.sql",
    );
  });

  it("keeps every direct table access path on a service-role client", () => {
    const receptionist = read(
      "src/shared/dashboard/receptionistActions.ts",
    );
    const edit = read("src/shared/dashboard/editBookingCore.ts");
    const ownerNotify = read(
      "src/shared/dashboard/sendOwnerBookingNotification.ts",
    );
    const cron = read(
      "src/app/api/cron/send-pending-notifications/route.ts",
    );
    const sms = read("src/app/api/twilio/sms/route.ts");

    for (const source of [receptionist, edit, ownerNotify, cron, sms]) {
      expect(source).toContain("createServiceRoleClient");
    }
    expect(ownerNotify).toContain(
      "admin: ReturnType<typeof createServiceRoleClient>",
    );
    expect(sms).toContain(
      "supabase: ReturnType<typeof createServiceRoleClient>",
    );
  });

  it("updates the blank-database parity tripwire", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("policies: 151");
    expect(parity).toContain(
      "const GRANTS = { anon: 57, authenticated: 64, service_role: 106 }",
    );
  });
});
