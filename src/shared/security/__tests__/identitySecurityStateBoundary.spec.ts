import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260724070000_deny_direct_identity_security_state_access.sql",
);
const proof = read(
  "scripts/security/check-identity-security-state-boundary.sql",
);
const rollback = read(
  "scripts/security/rehearse-identity-security-state-rollback.sql",
);

const tables = [
  "auth_events",
  "email_otp_codes",
  "phone_otp_sessions",
  "otp_send_log",
  "rate_limits",
];

describe("identity/security state boundary", () => {
  it("removes direct API grants and preserves service-role access", () => {
    for (const table of tables) {
      expect(migration).toContain(`public.${table}`);
      expect(proof).toContain(`'${table}'`);
    }
    expect(migration.match(/REVOKE ALL PRIVILEGES/g)).toHaveLength(5);
    expect(migration.match(/GRANT ALL PRIVILEGES/g)).toHaveLength(5);
    expect(proof).toMatch(
      /has_any_column_privilege\(\s*'authenticated'/,
    );
  });

  it("adds one restrictive false policy per table", () => {
    expect(migration.match(/AS RESTRICTIVE/g)).toHaveLength(5);
    expect(migration.match(/USING \(false\)/g)).toHaveLength(5);
    expect(migration.match(/WITH CHECK \(false\)/g)).toHaveLength(5);
    expect(proof).toContain("v_policy_count <> 1");
    expect(proof).toContain("AND NOT polpermissive");
  });

  it("rehearses the exact legacy ACL restoration inside a rollback", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("ROLLBACK;");
    expect(rollback).toContain(
      "GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER",
    );
    expect(rollback).toContain(
      "'anon', 'public.phone_otp_sessions', 'SELECT'",
    );
    expect(rollback).toContain(
      "\\ir check-identity-security-state-boundary.sql",
    );
  });

  it("keeps every runtime access path on a server-side service client", () => {
    const emailOtp = read("src/shared/lib/emailOtp.ts");
    const authWriter = read("src/shared/dashboard/recordAuthEvent.ts");
    const authReader = read(
      "src/shared/dashboard/loadActivityFeedAction.ts",
    );
    const sendRoute = read("src/app/api/booking-otp/send/route.ts");
    const verifyRoute = read("src/app/api/booking-otp/verify/route.ts");
    const consumeRoute = read(
      "src/app/api/booking-otp/consume-session/route.ts",
    );
    const voiceRoute = read("src/app/api/voice/tool/route.ts");
    const executor = read("src/shared/voiceai/toolExecutor.ts");

    for (const source of [emailOtp, authWriter]) {
      expect(source).toContain('import "server-only"');
      expect(source).toContain("createServiceRoleClient");
    }
    for (const source of [
      authReader,
      sendRoute,
      verifyRoute,
      consumeRoute,
      voiceRoute,
    ]) {
      expect(source).toContain("createServiceRoleClient");
    }
    expect(executor).toContain(
      "supabase: ReturnType<typeof createServiceRoleClient>",
    );
  });

  it("updates the blank-database parity tripwire", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("policies: 154");
    expect(parity).toContain(
      "const GRANTS = { anon: 57, authenticated: 64, service_role: 111 }",
    );
  });
});
