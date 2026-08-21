import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CONTROLLED_ROLLOUT_RELEASE_FLAG_KEYS,
  containsControlledRolloutFlagMutation,
  releaseFeatureEditableFlagKey,
} from "@/shared/features/featureRegistry";
import {
  GUIDED_SETUP_QA_DISABLE_CONFIRMATION,
  GUIDED_SETUP_QA_ENABLE_CONFIRMATION,
  parseGuidedSetupQaControlInput,
} from "@/shared/superadmin/guidedSetupQaControl";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260821014500_harden_guided_admin_setup_qa_rollout.sql",
);
const genericAction = read("src/shared/superadmin/superadminActions.ts");
const dedicatedAction = read(
  "src/shared/superadmin/guidedSetupQaControlAction.ts",
);
const rollback = read(
  "scripts/security/rehearse-guided-admin-setup-qa-rollout-rollback.sql",
);

function functionBody(source: string, exportedName: string): string {
  const start = source.indexOf(`export async function ${exportedName}`);
  const end = source.indexOf("export async function", start + 1);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, end > start ? end : undefined);
}

describe("Guided Admin Setup disposable-QA rollout database proof", () => {
  it("rejects generic set, false, and unset before constructing service-role access", () => {
    expect(CONTROLLED_ROLLOUT_RELEASE_FLAG_KEYS).toContain(
      "guided_admin_setup_enabled",
    );
    expect(releaseFeatureEditableFlagKey("guided_admin_setup")).toBeNull();
    for (const [featureFlags, featureFlagsUnset] of [
      [{ guided_admin_setup_enabled: true }, undefined],
      [{ guided_admin_setup_enabled: false }, undefined],
      [undefined, ["guided_admin_setup_enabled"]],
    ] as const) {
      expect(
        containsControlledRolloutFlagMutation(featureFlags, featureFlagsUnset),
      ).toBe(true);
    }

    const body = functionBody(genericAction, "updateSalonFlags");
    const guard = body.indexOf("containsControlledRolloutFlagMutation(");
    const rejection = body.indexOf(
      'return { ok: false, error: "invalid_payload" }',
      guard,
    );
    const privilegedClient = body.indexOf("createServiceRoleClient()");
    expect(guard).toBeGreaterThan(-1);
    expect(rejection).toBeGreaterThan(guard);
    expect(privilegedClient).toBeGreaterThan(rejection);
  });

  it("requires platform OFF and every tenant OFF before installing the QA control", () => {
    const preflight = migration.slice(
      migration.indexOf("DO $guided_setup_rollout_preflight$"),
      migration.indexOf("ALTER TABLE public.platform_settings"),
    );
    expect(preflight).toContain("feature_guided_admin_setup");
    expect(preflight).toMatch(
      /platform_flags[\s\S]*?(?:enabled IS TRUE|coalesce\([^)]*enabled[^)]*,\s*false\))/i,
    );
    expect(preflight).toContain("guided_admin_setup_enabled");
    expect(preflight).toContain("RAISE EXCEPTION");
  });

  it("uses exactly one platform singleton allowlist and atomic lock order", () => {
    expect(migration).toContain("guided_admin_setup_qa_salon_id uuid");
    expect(migration).toMatch(
      /WHERE ps\.id = 'platform'[\s\S]*?FOR UPDATE/i,
    );
    expect(migration).toMatch(
      /platform_flags[\s\S]*?FOR UPDATE[\s\S]*?platform_settings[\s\S]*?FOR UPDATE[\s\S]*?public\.salons[\s\S]*?FOR UPDATE/i,
    );
    expect(migration).toMatch(
      /v_allowlisted IS NOT NULL AND v_allowlisted IS DISTINCT FROM p_salon_id[\s\S]*?'allowlist_conflict'/,
    );
  });

  it("keeps platform OFF fail-closed at enable time", () => {
    expect(migration).toMatch(
      /feature_guided_admin_setup[\s\S]*?coalesce\(pf\.enabled, false\)/,
    );
    expect(migration).toMatch(
      /IF NOT coalesce\(v_platform_enabled, false\)[\s\S]*?'platform_disabled'/,
    );
  });

  it("rejects archived, non-Beta, inactive, and both Hi-Lite identities", () => {
    for (const required of [
      "archived_at IS NOT NULL",
      "is_beta IS NOT TRUE",
      "subscription_status NOT IN ('active', 'trialing')",
      "'hi-lite head spa'",
      "'hi-lite studio'",
      "'hilite-anaheim'",
      "'hilite-studio'",
      "salon_not_disposable_qa",
    ]) {
      expect(migration.toLowerCase()).toContain(required.toLowerCase());
    }
    expect(migration).toMatch(
      /v_allowlisted IS DISTINCT FROM NEW\.id[\s\S]*?NEW\.archived_at IS NOT NULL[\s\S]*?NEW\.is_beta IS NOT TRUE/,
    );
  });

  it("requires exact enable/disable phrases and the same confirmed salon id", () => {
    const salonId = "26000000-0000-4000-8000-000000000001";
    expect(
      parseGuidedSetupQaControlInput({
        salonId,
        confirmedSalonId: salonId,
        enable: true,
        confirmation: GUIDED_SETUP_QA_ENABLE_CONFIRMATION,
      }),
    ).not.toBeNull();
    expect(
      parseGuidedSetupQaControlInput({
        salonId,
        confirmedSalonId: salonId,
        enable: false,
        confirmation: GUIDED_SETUP_QA_DISABLE_CONFIRMATION,
      }),
    ).not.toBeNull();
    expect(
      parseGuidedSetupQaControlInput({
        salonId,
        confirmedSalonId: "26000000-0000-4000-8000-000000000002",
        enable: true,
        confirmation: GUIDED_SETUP_QA_ENABLE_CONFIRMATION,
      }),
    ).toBeNull();
    expect(
      parseGuidedSetupQaControlInput({
        salonId,
        confirmedSalonId: salonId,
        enable: true,
        confirmation: GUIDED_SETUP_QA_ENABLE_CONFIRMATION.toLowerCase(),
      }),
    ).toBeNull();
    expect(migration).toContain("'ENABLE_GUIDED_ADMIN_SETUP_QA'");
    expect(migration).toContain("'DISABLE_GUIDED_ADMIN_SETUP_QA'");
  });

  it("keeps the dedicated RPC service-role-only and behind active platform auth", () => {
    expect(migration).toMatch(
      /IF v_role <> 'service_role'[\s\S]*?'unauthorized'/,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.configure_guided_admin_setup_qa_salon\(uuid, boolean, text\)[\s\S]*?FROM PUBLIC, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.configure_guided_admin_setup_qa_salon\(uuid, boolean, text\)[\s\S]*?TO service_role/i,
    );

    const body = functionBody(
      dedicatedAction,
      "configureGuidedSetupQaSalon",
    );
    expect(body.indexOf("requireActiveSuperAdminSession()")).toBeGreaterThan(-1);
    expect(body.indexOf('role !== "founder"')).toBeGreaterThan(-1);
    expect(body.indexOf('role !== "ops_admin"')).toBeGreaterThan(-1);
    expect(body.indexOf("writeAuditLog(")).toBeGreaterThan(-1);
    expect(body.indexOf("createServiceRoleClient().rpc(")).toBeGreaterThan(
      body.indexOf("writeAuditLog("),
    );
  });

  it("rehearses safe disable rollback and restores the hardened objects", () => {
    expect(rollback).toContain("DISABLE_GUIDED_ADMIN_SETUP_QA");
    expect(rollback).toContain("configure_guided_admin_setup_qa_salon");
    expect(rollback).toContain("guided_admin_setup_qa_salon_id");
    expect(rollback).toContain("guided_admin_setup_enabled");
    expect(rollback).toContain("rollback rehearsal did not restore");
    expect(rollback.trimEnd()).toMatch(/rollback;$/i);
  });
});
