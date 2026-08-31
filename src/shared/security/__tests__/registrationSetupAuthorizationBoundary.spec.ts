import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260820055259_complete_existing_owner_registration_setup.sql",
);
const action = read(
  "src/shared/register/completeSalonRegistrationAction.ts",
);
const parity = read("scripts/check-schema-parity.ts");

describe("existing-owner registration setup database boundary", () => {
  it("rechecks sole exact-owner authorization and incomplete state in the UPDATE", () => {
    expect(migration).toContain("security invoker");
    expect(migration).toContain(
      "lock table public.salon_members in share mode",
    );
    expect(migration).toContain(
      "'service_role', 'public.salon_members', 'UPDATE'",
    );
    expect(migration).toContain("membership.role = 'owner'");
    expect(migration).toContain("salon.setup_wizard_completed_at is null");
    expect(migration).toContain("select count(*)");
    expect(migration).toContain("membership.user_id = p_actor_user_id");
  });

  it("keeps the RPC service-role only", () => {
    expect(migration).toContain(
      ") from public, anon, authenticated;",
    );
    expect(migration).toContain(") to service_role;");
    expect(migration).not.toContain("security definer");
  });

  it("does not perform a direct service-role salon update", () => {
    expect(action).toContain(
      '"complete_existing_owner_registration_setup" as never',
    );
    expect(action).not.toMatch(
      /renameAdmin\s*\.from\("salons"\)[\s\S]{0,300}\.update\(/,
    );
  });

  it("updates the blank-database function tripwire", () => {
    expect(parity).toContain("functions: 444");
    expect(parity).toContain(
      '"complete_existing_owner_registration_setup"',
    );
  });
});
