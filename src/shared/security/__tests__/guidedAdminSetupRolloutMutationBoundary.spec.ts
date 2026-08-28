import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260821014500_harden_guided_admin_setup_qa_rollout.sql",
);
const rolloutBaseline = read(
  "supabase/migrations/20260820064326_protect_guided_admin_setup_rollout_flag.sql",
);
const proof = read(
  "scripts/security/check-guided-admin-setup-qa-rollout-runtime.sql",
);
const rollback = read(
  "scripts/security/rehearse-guided-admin-setup-qa-rollout-rollback.sql",
);
const registry = read("src/shared/features/featureRegistry.ts");
const workflow = read(".github/workflows/migration-history-rehearsal.yml");
const parity = read("scripts/check-schema-parity.ts");

describe("Guided Admin Setup rollout mutation boundary", () => {
  it("protects the exact default-off registry store without minting an alias", () => {
    expect(registry).toMatch(
      /guided_admin_setup:\s*\{[\s\S]*?defaultOn:\s*false,[\s\S]*?flagKey:\s*"guided_admin_setup_enabled"/,
    );
    expect(migration).toContain(
      "NEW.feature_flags->'guided_admin_setup_enabled'",
    );
    expect(migration).not.toMatch(/feature_flags\s*->\s*'guided_admin_setup'/);
  });

  it("gates UPDATE and enabled INSERT values but preserves default-off inserts", () => {
    expect(migration).toContain("TG_OP = 'INSERT'");
    expect(migration).toContain(
      "coalesce(v_new, 'false'::jsonb) <> 'true'::jsonb",
    );
    expect(rolloutBaseline).toMatch(
      /before insert or update of feature_flags[\s\S]*on public\.salons/i,
    );
    expect(migration).toContain(
      "guided admin setup rollout requires the dedicated QA setter",
    );
  });

  it("allows only the dedicated service/local path and exact QA allowlist", () => {
    expect(migration).toContain("v_role = 'service_role'");
    expect(migration).not.toContain("FROM public.superadmins");
    expect(migration).toMatch(
      /v_role = ''[\s\S]*session_user IN \('postgres', 'supabase_admin'\)/,
    );
    expect(migration).toContain("guided_admin_setup_qa_salon_id");
    expect(migration).toContain("v_allowlisted IS DISTINCT FROM NEW.id");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path TO ''");
    expect(migration).toMatch(
      /revoke all on function public\.protect_guided_admin_setup_rollout_flag\(\)[\s\S]*from public, anon, authenticated/i,
    );
  });

  it("proves platform, tenant, lifecycle and Hi-Lite denials", () => {
    expect(proof).toContain("platform_disabled");
    expect(proof).toContain("confirmation_required");
    expect(proof).toContain("salon_not_disposable_qa");
    expect(proof).toContain("allowlist_conflict");
    expect(proof).toContain("Hi-Lite Head Spa");
    expect(proof).toContain("Hi-Lite Studio");
    expect(proof).toContain("hilite-anaheim");
    expect(proof).toContain("hilite-studio");
    expect(proof).toContain("set local role service_role");
  });

  it("proves generic direct updates cannot escape the exact singleton", () => {
    expect(proof).toContain("generic service-role update escaped");
    expect(proof).toContain("generic authenticated unset escaped");
    expect(proof).toContain("guided_admin_setup_qa_salon_id is not null");
  });

  it("rehearses safe disable without removing the security boundary", () => {
    expect(rollback).toContain("DISABLE_GUIDED_ADMIN_SETUP_QA");
    expect(rollback).not.toContain("drop trigger");
    expect(rollback).not.toContain("drop function");
    expect(rollback).toContain(
      "safe rollout rollback left the singleton allowlist set",
    );
    expect(rollback).toContain(
      "rollback rehearsal did not restore the hardened trigger",
    );
  });

  it("wires direct proof, rollback, parity, and critical-object history", () => {
    expect(workflow).toContain(
      "scripts/security/check-guided-admin-setup-qa-rollout-runtime.sql",
    );
    expect(workflow).toContain(
      "scripts/security/rehearse-guided-admin-setup-qa-rollout-rollback.sql",
    );
    expect(parity).toContain("functions: 397");
    expect(parity).toContain("triggers: 93");
    expect(parity).toContain('"protect_guided_admin_setup_rollout_flag"');
    expect(parity).toContain('"configure_guided_admin_setup_qa_salon"');
  });
});
