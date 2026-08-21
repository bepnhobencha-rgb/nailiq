import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CONTROLLED_ROLLOUT_RELEASE_FLAG_KEYS,
  EDITABLE_RELEASE_FLAG_KEYS,
  releaseFeatureEditableFlagKey,
} from "@/shared/features/featureRegistry";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const superadminActions = read("src/shared/superadmin/superadminActions.ts");
const superadminTypes = read("src/shared/superadmin/superadminTypes.ts");
const sequenceMigration = read(
  "supabase/migrations/20260820180036_add_authoritative_booking_service_sequences.sql",
);

describe("multi-service disposable-QA rollout boundary", () => {
  it("removes the controlled tenant flag from every generic all-salon editor", () => {
    expect(CONTROLLED_ROLLOUT_RELEASE_FLAG_KEYS).toContain(
      "multi_service_booking_enabled",
    );
    expect(EDITABLE_RELEASE_FLAG_KEYS).not.toContain(
      "multi_service_booking_enabled",
    );
    expect(releaseFeatureEditableFlagKey("multi_service_booking")).toBeNull();
    expect(superadminTypes).not.toContain('key: "multi_service_booking_enabled"');
  });

  it("rejects generic set/unset attempts before constructing a service-role writer", () => {
    const updateStart = superadminActions.indexOf(
      "export async function updateSalonFlags",
    );
    const updateEnd = superadminActions.indexOf(
      "export async function",
      updateStart + 1,
    );
    const updateBody = superadminActions.slice(
      updateStart,
      updateEnd > updateStart ? updateEnd : undefined,
    );
    const controlledGuard = updateBody.indexOf(
      "containsControlledRolloutFlagMutation(",
    );
    const rejection = updateBody.indexOf(
      'return { ok: false, error: "invalid_payload" }',
      controlledGuard,
    );
    const serviceRoleConstruction = updateBody.indexOf(
      "createServiceRoleClient()",
    );
    expect(updateStart).toBeGreaterThan(-1);
    expect(controlledGuard).toBeGreaterThan(-1);
    expect(rejection).toBeGreaterThan(controlledGuard);
    expect(serviceRoleConstruction).toBeGreaterThan(rejection);
  });

  it("requires platform OFF and every active salon OFF before Phase-A schema lands", () => {
    const preflight = sequenceMigration.slice(
      sequenceMigration.indexOf("DO $hilite_sequence_rollout_preflight$"),
      sequenceMigration.indexOf("ALTER TABLE public.services"),
    );
    expect(preflight).toContain("feature_multi_service_booking");
    expect(preflight).toContain("s.archived_at IS NULL");
    expect(preflight).toContain("multi_service_booking_enabled");
    expect(preflight).toContain("hi-lite head spa");
    expect(preflight).toContain("hi-lite studio");
    expect(preflight).toContain("RAISE EXCEPTION");
  });

  it("allows true only for the exact configured active Beta QA salon and rejects Hi-Lite", () => {
    expect(sequenceMigration).toContain("multi_service_booking_qa_salon_id");
    expect(sequenceMigration).toContain(
      "CREATE OR REPLACE FUNCTION public.protect_multi_service_booking_rollout_flag",
    );
    expect(sequenceMigration).toContain(
      "CREATE TRIGGER protect_multi_service_booking_rollout_flag_trigger",
    );
    expect(sequenceMigration).toMatch(
      /v_allowlisted IS DISTINCT FROM NEW\.id[\s\S]{0,180}?NEW\.archived_at IS NOT NULL[\s\S]{0,180}?NEW\.is_beta IS NOT TRUE/,
    );
    expect(sequenceMigration).toMatch(
      /lower\(trim\(NEW\.name\)\) IN \('hi-lite head spa', 'hi-lite studio'\)/,
    );
    expect(sequenceMigration).toMatch(
      /v_new IS NOT NULL AND pg_catalog\.jsonb_typeof\(v_new\) <> 'boolean'[\s\S]{0,160}?RAISE EXCEPTION/,
    );
  });
});
