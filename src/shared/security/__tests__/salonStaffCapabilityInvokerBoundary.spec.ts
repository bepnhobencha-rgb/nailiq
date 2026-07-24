import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

describe("salon staff-capability invoker boundary", () => {
  it("converts only the read-only capability probe to SECURITY INVOKER", () => {
    const migration = read(
      "supabase/migrations/20260724050000_use_security_invoker_salon_staff_capability.sql",
    );

    expect(migration).toMatch(
      /ALTER FUNCTION public\.salon_has_staff_services\(uuid\)[\s\S]*SECURITY INVOKER/i,
    );
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(migration).toContain("prosecdef");
    expect(migration).toContain(
      "PUBLIC=false, anon=false, authenticated=true, service_role=true",
    );
  });

  it("proves the invoker has table access and membership-scoped staff RLS", () => {
    const proof = read(
      "scripts/security/check-salon-staff-capability-invoker.sql",
    );

    expect(proof).toContain("members read staff for own salon");
    expect(proof).toContain(
      "has_table_privilege('authenticated', 'public.staff', 'SELECT')",
    );
    expect(proof).toContain("'public.staff_services'");
    expect(proof).toContain("prosecdef");
  });

  it("rehearses SECURITY DEFINER restoration and rolls it back in CI", () => {
    const rollback = read(
      "scripts/security/rehearse-salon-staff-capability-definer-rollback.sql",
    );
    const workflow = read(
      ".github/workflows/migration-history-rehearsal.yml",
    );

    expect(rollback).toMatch(/BEGIN;/);
    expect(rollback).toMatch(
      /ALTER FUNCTION public\.salon_has_staff_services\(uuid\)[\s\S]*SECURITY DEFINER/i,
    );
    expect(rollback).toMatch(/ROLLBACK;/);
    expect(rollback).toContain(
      "\\ir check-salon-staff-capability-invoker.sql",
    );
    expect(workflow).toContain(
      "scripts/security/check-salon-staff-capability-invoker.sql",
    );
    expect(workflow).toContain(
      "scripts/security/rehearse-salon-staff-capability-definer-rollback.sql",
    );
  });
});
