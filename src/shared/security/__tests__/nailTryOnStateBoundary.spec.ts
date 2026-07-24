import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260724090000_explicit_nail_tryon_state_policies.sql",
);
const proof = read(
  "scripts/security/check-nail-tryon-state-boundary.sql",
);
const rollback = read(
  "scripts/security/rehearse-nail-tryon-state-rollback.sql",
);

const tables = [
  "nail_tryon_cleanup_queue",
  "nail_tryon_events",
  "nail_tryon_sessions",
];

describe("nail-tryon state boundary", () => {
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
      "\\ir check-nail-tryon-state-boundary.sql",
    );
  });

  it("keeps every direct table access path on a service-role client", () => {
    const telemetry = read("src/shared/nailTryOn/telemetry.ts");
    const upload = read("src/app/api/nail-tryon/upload/route.ts");
    const generate = read("src/app/api/nail-tryon/generate/route.ts");
    const attach = read("src/app/api/nail-tryon/attach/route.ts");
    const intent = read(
      "src/app/api/nail-tryon/booking-intent/route.ts",
    );
    const cleanup = read(
      "src/app/api/cron/nail-tryon-cleanup/route.ts",
    );

    for (const source of [
      telemetry,
      upload,
      generate,
      attach,
      intent,
      cleanup,
    ]) {
      expect(source).toContain("createServiceRoleClient");
    }
    expect(telemetry).toContain('import "server-only"');
    expect(generate).toContain("verifySessionCredential");
    expect(attach).toContain("verifySessionCredential");
    expect(intent).toContain("verifySessionCredential");
    expect(cleanup).toContain("CRON_SECRET");
  });

  it("updates the blank-database parity tripwire", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("policies: 131");
    expect(parity).toContain(
      "const GRANTS = { anon: 63, authenticated: 66, service_role: 94 }",
    );
  });
});
