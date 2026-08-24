import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260820062352_harden_setup_catalog_mutation_rls.sql",
);
const matrix = read(
  "scripts/security/check-setup-catalog-mutation-rls.sql",
);
const deniedMatrix = read(
  "scripts/security/assert-setup-catalog-denied.psql",
);
const rollback = read(
  "scripts/security/rehearse-setup-catalog-mutation-rls-rollback.sql",
);
const workflow = read(".github/workflows/migration-history-rehearsal.yml");

describe("setup catalog direct Data API mutation boundary", () => {
  it("limits service and staff capability writes to owner/admin", () => {
    expect(migration).toContain("sm.role in ('owner', 'admin')");
    expect(migration).toContain('on public.services');
    expect(migration).toContain('on public.staff_services');
    expect(migration).toContain('"owner admin write staff_services"');
    expect(migration).not.toContain("feature_flags");
  });

  it("replaces policies one-for-one and preserves intentional public reads", () => {
    expect(migration.match(/drop policy if exists/g)).toHaveLength(4);
    expect(migration.match(/create policy/g)).toHaveLength(4);
    expect(migration).toContain("public read active service catalog");
    expect(migration).toContain("anon read staff_services");
  });

  it("covers every current lower role plus cross-tenant writes directly", () => {
    for (const role of [
      "senior",
      "receptionist",
      "nail_tech",
      "cross-tenant owner",
    ]) {
      expect(matrix).toContain(`'${role}'`);
    }
    expect(matrix).toContain("set local role authenticated");
    expect(matrix.match(/\\ir assert-setup-catalog-denied\.psql/g)).toHaveLength(
      4,
    );
    expect(matrix).not.toContain("create function");
    expect(deniedMatrix).toContain("set price_cents = 1, duration_minutes = 1");
    expect(deniedMatrix).toContain("unexpectedly changed a staff capability");
    expect(deniedMatrix).toContain("returning 1");
    expect(deniedMatrix).toContain("= '42501'");
    expect(matrix).toContain("set local role anon");
  });

  it("keeps the behavior and rollback proofs in migration-history CI", () => {
    expect(workflow).toContain(
      "-f scripts/security/check-setup-catalog-mutation-rls.sql",
    );
    expect(workflow).toContain(
      '- "scripts/security/assert-setup-catalog-denied.psql"',
    );
    expect(workflow).toContain(
      "-f scripts/security/rehearse-setup-catalog-mutation-rls-rollback.sql",
    );
    expect(rollback).toContain('"members write staff_services"');
    expect(rollback).toContain("rollback;");
  });
});
