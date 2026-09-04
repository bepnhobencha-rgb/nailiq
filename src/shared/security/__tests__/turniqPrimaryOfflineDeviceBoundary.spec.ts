import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260902202020_add_turniq_primary_offline_device.sql",
), "utf8");
const serviceWorker = readFileSync(resolve(process.cwd(), "public/nailiq-sw.js"), "utf8");

describe("TurnIQ M5 primary offline device boundary", () => {
  it("allows exactly one primary lease and rotates the generation", () => {
    expect(migration).toContain("CREATE UNIQUE INDEX turniq_one_primary_offline_device_idx");
    expect(migration).toContain("WHERE status = 'primary'");
    expect(migration).toContain("v_generation := v_state.device_generation + 1");
    expect(migration).toContain("replaced_by_new_primary");
    expect(migration).toContain("v_existing.id = p_device_id");
    expect(migration).toContain("'replayed', true");
  });

  it("requires ordered, snapshot-bound, policy-bound replay", () => {
    expect(migration).toContain("turniq-offline-command:");
    expect(migration).toContain("v_device.generation <> p_device_generation");
    expect(migration).toContain("v_device.snapshot_policy_version_id IS DISTINCT FROM p_policy_version_id");
    expect(migration).toContain("v_device.snapshot_fingerprint IS DISTINCT FROM p_snapshot_fingerprint");
    expect(migration).toContain("p_local_sequence <> v_device.last_acked_sequence + 1");
    expect(migration).toContain("p_expected_state_version <> v_state.state_version");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("p_command_id IS NULL");
  });

  it("supports PII-free walk-in intake and only schedule-neutral offline add-ons", () => {
    expect(migration).toContain("apply_turniq_offline_walkin_command_v1");
    expect(migration).toContain("'Offline guest '");
    expect(migration).toContain("'identity_match_required', true");
    expect(migration).toContain("apply_turniq_offline_service_update_command_v1");
    expect(migration).toContain("AND s.duration_minutes = 0");
    expect(migration).toContain("timed add-ons require online schedule validation");
    expect(migration).toContain("opportunity_credit_cents = v_main_price + v_addon_price");
  });

  it("preserves every earlier TurnIQ command type when extending the ledger", () => {
    for (const commandType of [
      "correction",
      "acknowledge_exception",
      "resolve_exception",
      "dismiss_exception",
      "recommend_group",
      "confirm_group",
      "service_update",
      "walkin_intake",
    ]) expect(migration).toContain(`'${commandType}'`);
  });

  it("does not write a foreign-key-invalid conflict for a never-paired device", () => {
    expect(migration).toContain("v_device_exists := FOUND");
    expect(migration).toMatch(/IF v_device_exists THEN[\s\S]*?record_turniq_offline_conflict_v1/);
  });

  it("keeps all tables and RPCs service-role-only with forced RLS", () => {
    for (const table of [
      "turniq_offline_state",
      "turniq_offline_devices",
      "turniq_offline_reconciliations",
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(migration).toMatch(/REVOKE ALL ON TABLE[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/);
    expect(migration).not.toMatch(/GRANT[^;]*TO anon|GRANT[^;]*TO authenticated/i);
    expect(migration).not.toContain("SECURITY DEFINER");
    expect(migration).not.toContain("pg_catalog.coalesce(");
    expect(migration).toContain("m.user_id = p_actor_user_id");
  });

  it("indexes every new foreign-key access path used by device and conflict cleanup", () => {
    for (const index of [
      "turniq_offline_device_paired_by_idx",
      "turniq_offline_device_revoked_by_idx",
      "turniq_offline_device_snapshot_policy_fk_idx",
      "turniq_offline_reconciliation_device_idx",
      "turniq_offline_reconciliation_policy_fk_idx",
      "turniq_offline_reconciliation_resolved_by_idx",
    ]) expect(migration).toContain(`CREATE INDEX ${index}`);
  });

  it("caches only the offline shell/static assets and never API or action responses", () => {
    expect(serviceWorker).toContain('const OFFLINE_PATH = "/turniq/offline"');
    expect(serviceWorker).toContain('url.pathname.startsWith("/_next/static/")');
    expect(serviceWorker).toContain('request.mode === "navigate"');
    expect(serviceWorker).not.toMatch(/caches\.put\([^\n]*(api|action)/i);
  });

  it("publishes offline HTML only after every executable asset is cached", () => {
    const assetWarm = serviceWorker.indexOf("for (const url of assetUrls)");
    const readinessGate = serviceWorker.indexOf("if (!allAssetsCached || !offlineUrl) return;");
    const htmlPublish = serviceWorker.indexOf("await cache.put(offlineUrl.href, response)");
    expect(assetWarm).toBeGreaterThan(-1);
    expect(readinessGate).toBeGreaterThan(assetWarm);
    expect(htmlPublish).toBeGreaterThan(readinessGate);
  });

  it("remains dormant and preserves evidence during rollback", () => {
    expect(migration).toContain("no salon/device is enabled by this migration");
    expect(migration).toContain("Never drop command/event/receipt history");
    expect(migration).not.toMatch(/UPDATE public\.salons|INSERT INTO public\.salons/i);
  });
});
