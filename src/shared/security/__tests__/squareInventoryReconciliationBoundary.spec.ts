import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(join(
  root,
  "supabase/migrations/20260822174938_add_square_inventory_reconciliation.sql",
), "utf8");
const runtime = readFileSync(join(
  root,
  "src/shared/integrations/square/inventoryReconciliation.ts",
), "utf8");
const worker = readFileSync(join(
  root,
  "src/shared/integrations/square/inventoryWorker.ts",
), "utf8");
const cron = readFileSync(join(root, "src/app/api/cron/square-sync/route.ts"), "utf8");
const optional = readFileSync(join(
  root,
  "src/shared/integrations/square/optionalCapabilities.ts",
), "utf8");
const concurrency = readFileSync(join(
  root,
  "scripts/security/rehearse-square-inventory-concurrency.mjs",
), "utf8");

describe("MQA-0127 Square Inventory reconciliation boundary", () => {
  it("keeps Inventory hard off and contains no provider dispatch", () => {
    expect(optional).toContain('SQUARE_OPTIONAL_API_VERSION = "2026-07-15"');
    expect(optional).toMatch(/inventory:\s*false/);
    expect(migration).toMatch(/performs no provider\s+-- call/);
    expect(runtime).not.toMatch(/fetch\(|squareup\.com|Authorization/);
    expect(worker).toMatch(
      /export async function syncSquareInventoryCatalogForSalon[\s\S]{0,500}if \(!SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE\.inventory\)[\s\S]{0,300}return \{ status: "disabled"/,
    );
    expect(worker).not.toMatch(/fetch\(|squareup\.com|Authorization/);
    expect(cron).toContain("syncSquareInventoryCatalogForSalon");
  });

  it("models only provider-owned REGULAR retail variations, never services or recipes", () => {
    expect(migration).toContain("product_type text NOT NULL CHECK (product_type = 'REGULAR')");
    expect(migration).toContain("Never services, ingredients, or bundles");
    expect(runtime).toContain('itemData.product_type !== "REGULAR"');
    expect(migration).not.toMatch(/REFERENCES public\.services/i);
  });

  it("requires an owner/admin auth.uid decision before mapping confirmation", () => {
    expect(migration).toContain("confirm_square_inventory_retail_mapping");
    expect(migration).toContain("v_actor uuid := (SELECT auth.uid())");
    expect(migration).toContain("m.role IN ('owner', 'admin')");
    expect(migration).toContain("status text NOT NULL DEFAULT 'pending'");
    expect(migration).not.toMatch(/GRANT (ALL|INSERT|UPDATE|DELETE).*square_inventory_retail_mappings/i);
  });

  it("adopts count revisions immutably and chooses a deterministic newest snapshot", () => {
    expect(migration).toContain("Square inventory count event mirrors are immutable");
    expect(migration).toContain("apply_square_inventory_webhook_event");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("EXCLUDED.calculated_at, EXCLUDED.last_event_at, EXCLUDED.last_event_id");
    expect(concurrency).toContain("Promise.all(claims.map(apply))");
    expect(concurrency).toContain('"15.00000"');
  });

  it("uses Square latest_time as the catalog cursor and retains refresh markers", () => {
    expect(runtime).toContain("latest_time");
    expect(runtime).toContain("include_deleted_objects: true");
    expect(migration).toContain("refresh_required_since");
    expect(migration).toContain("p_provider_latest_time::text");
    expect(migration).toContain("catalog_receipt_required");
    expect(migration).toContain("provider_payload_mismatch");
    expect(migration).toContain("active_catalog_cursor");
    expect(migration).toContain("reconcile_stale_square_inventory_catalog_operations");
    expect(worker).toContain("p_next_cursor: page.cursor");
    expect(worker).toContain("provider_read_unavailable");
  });

  it("uses forced RLS and explicit read-only grants", () => {
    expect(migration.match(/FORCE ROW LEVEL SECURITY/g)?.length).toBe(5);
    expect(migration).toContain("GRANT SELECT ON public.square_inventory_catalog_variation_mirrors");
    expect(migration).toContain("TO service_role");
    expect(migration).toContain("TO authenticated");
  });
});
