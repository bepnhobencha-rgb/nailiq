import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

describe("public group-slot probe role boundary", () => {
  it("always invokes the probe through the stateless anon client", () => {
    const action = read("src/shared/booking/checkGroupSlotsAvailable.ts");

    expect(action).toContain(
      'createPublicClient } from "@/shared/lib/supabase/publicClient"',
    );
    expect(action).toContain("const supabase = createPublicClient()");
    expect(action).not.toContain(
      'createClient } from "@/shared/lib/supabase/server"',
    );
  });

  it("revokes authenticated execute while preserving anon and service role", () => {
    const migration = read(
      "supabase/migrations/20260724041500_restrict_group_slot_probe_to_anon.sql",
    );
    const currentProof = read(
      "scripts/security/check-public-rpc-role-grants.sql",
    );

    expect(migration).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.check_group_slots_available\(jsonb\)[\s\S]*FROM authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.check_group_slots_available\(jsonb\)[\s\S]*TO anon, service_role/i,
    );
    expect(currentProof).toContain(
      "('public.check_group_slots_available(jsonb)', true, false)",
    );
  });

  it("rehearses the exact prior grant and rolls it back in CI", () => {
    const rollback = read(
      "scripts/security/rehearse-group-slot-probe-grant-rollback.sql",
    );
    const workflow = read(
      ".github/workflows/migration-history-rehearsal.yml",
    );

    expect(rollback).toMatch(/BEGIN;/);
    expect(rollback).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.check_group_slots_available\(jsonb\)[\s\S]*TO authenticated/i,
    );
    expect(rollback).toMatch(/ROLLBACK;/);
    expect(rollback).toContain("\\ir check-public-rpc-role-grants.sql");
    expect(workflow).toContain(
      "scripts/security/rehearse-group-slot-probe-grant-rollback.sql",
    );
  });
});
