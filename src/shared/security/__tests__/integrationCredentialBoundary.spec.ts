import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260724060000_deny_direct_integration_credential_access.sql",
);
const proof = read(
  "scripts/security/check-integration-credential-boundary.sql",
);
const rollback = read(
  "scripts/security/rehearse-integration-credential-boundary-rollback.sql",
);

describe("integration credential boundary", () => {
  it("removes all direct API grants and preserves service-role access", () => {
    for (const table of ["square_integrations", "wix_integrations"]) {
      expect(migration).toContain(`public.${table}`);
      expect(proof).toContain(`'${table}'`);
    }

    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*FROM PUBLIC, anon, authenticated/g,
    );
    expect(migration).toMatch(
      /GRANT ALL PRIVILEGES[\s\S]*TO service_role/g,
    );
    expect(proof).toContain(
      "has_any_column_privilege('authenticated'",
    );
  });

  it("adds an explicit restrictive deny instead of an allow policy", () => {
    expect(migration.match(/AS RESTRICTIVE/g)).toHaveLength(2);
    expect(migration.match(/USING \(false\)/g)).toHaveLength(2);
    expect(migration.match(/WITH CHECK \(false\)/g)).toHaveLength(2);
    expect(proof).toContain("AND NOT polpermissive");
    expect(proof).toContain("pg_get_expr(polqual, polrelid) = 'false'");
    expect(proof).toContain(
      "pg_get_expr(polwithcheck, polrelid) = 'false'",
    );
  });

  it("keeps the exact legacy restoration transaction-scoped", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("ROLLBACK;");
    expect(rollback).toContain(
      "GRANT ALL PRIVILEGES ON TABLE public.square_integrations",
    );
    expect(rollback).toContain(
      "GRANT ALL PRIVILEGES ON TABLE public.wix_integrations",
    );
    expect(rollback).toContain(
      "\\ir check-integration-credential-boundary.sql",
    );
  });

  it("keeps runtime integration access on server-only service clients", () => {
    const squareDb = read("src/shared/integrations/square/looseDb.ts");
    const wixDb = read("src/shared/integrations/wix/looseDb.ts");
    const squareClient = read("src/shared/integrations/square/client.ts");
    const wixClient = read("src/shared/integrations/wix/client.ts");

    for (const source of [squareDb, wixDb]) {
      expect(source).toContain("createServiceRoleClient");
      expect(source).toContain('import "server-only"');
    }
    expect(squareClient).toContain(
      "Load Square credentials for a salon from the service-role DB",
    );
    expect(wixClient).toContain('import "server-only"');
    expect(wixClient).toContain("looseServiceClient()");
  });

  it("updates the blank-database parity tripwire for the forward migration", () => {
    const parity = read("scripts/check-schema-parity.ts");

    expect(parity).toContain("policies: 198");
    expect(parity).toContain(
      "const GRANTS = { anon: 56, authenticated: 77, service_role: 176 }",
    );
  });
});
