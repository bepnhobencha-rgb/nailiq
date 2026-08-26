import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260825013913_v1_fast_track_staff_capability.sql",
  ),
  "utf8",
);
const setupActions = readFileSync(
  resolve(process.cwd(), "src/shared/dashboard/setupActions.ts"),
  "utf8",
);

describe("V1 Fast Track staff capability boundary", () => {
  it("persists an explicit legacy_all/whitelist mode", () => {
    expect(migration).toContain("staff_capability_mode text NOT NULL DEFAULT 'legacy_all'");
    expect(migration).toContain("staff_capability_mode IN ('legacy_all', 'whitelist')");
    expect(migration).toContain("SET staff_capability_mode = 'whitelist'");
  });

  it("uses one tenant-scoped owner/admin RPC for the complete replacement", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.set_staff_service_capabilities\([\s\S]*sm\.role IN \('owner', 'admin'\)[\s\S]*FOR UPDATE[\s\S]*service_tenant_mismatch[\s\S]*INSERT INTO public\.staff_services[\s\S]*DELETE FROM public\.staff_services/u,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.set_staff_service_capabilities[\s\S]*FROM PUBLIC, anon;[\s\S]*GRANT EXECUTE[\s\S]*TO authenticated, service_role/u,
    );
  });

  it("seeds legacy colleagues and blocks reopening the global zero-row fallback", () => {
    expect(migration).toMatch(
      /v_mode = 'legacy_all'[\s\S]*CROSS JOIN public\.services[\s\S]*ON CONFLICT \(staff_id, service_id\) DO NOTHING/u,
    );
    expect(migration).toContain("capability_whitelist_cannot_be_globally_empty");
    expect(migration).toContain("ss.staff_id <> p_staff_id");
    expect(migration).toContain("staff_capability_mode_cannot_reopen_legacy");
    expect(migration).toContain("BEFORE INSERT OR DELETE OR UPDATE");
    expect(migration).toContain("current_user IN ('service_role', 'postgres', 'supabase_admin')");
    expect(migration).toMatch(
      /FUNCTION public\.enforce_staff_capability_write\(\)\nRETURNS trigger\nLANGUAGE plpgsql\nSECURITY INVOKER/u,
    );
  });

  it("routes updateStaff through the atomic RPC instead of delete-then-insert", () => {
    expect(setupActions).toMatch(
      /if \(touchServices\)[\s\S]*rpc\([\s\S]*set_staff_service_capabilities[\s\S]*p_salon_id:[\s\S]*p_staff_id:[\s\S]*p_service_ids:/u,
    );
    const updateStaffBlock = setupActions.slice(
      setupActions.indexOf("export async function updateStaff"),
      setupActions.indexOf("export async function deleteStaff"),
    );
    expect(updateStaffBlock).not.toContain('.from("staff_services").delete()');
  });
});
