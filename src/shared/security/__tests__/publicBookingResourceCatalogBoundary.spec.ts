import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260908014241_fix_public_booking_resource_catalog.sql",
  ),
  "utf8",
);
const hardening = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260921170000_harden_public_booking_resource_catalog_invoker.sql",
  ),
  "utf8",
);
const rehearsal = readFileSync(
  resolve(
    process.cwd(),
    "scripts/security/rehearse-public-booking-resource-catalog.sql",
  ),
  "utf8",
);

describe("public booking resource catalog boundary", () => {
  it("keeps the production migration represented in source control", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE VIEW public.public_booking_resource_catalog",
    );
    expect(migration).toContain("WITH (security_barrier = true)");
    expect(migration).toContain("SET search_path = ''");
  });

  it("exposes only the public resource identity projection", () => {
    const viewStart = migration.indexOf(
      "CREATE OR REPLACE VIEW public.public_booking_resource_catalog",
    );
    const viewEnd = migration.indexOf("COMMENT ON VIEW", viewStart);
    const view = migration.slice(viewStart, viewEnd);

    expect(view).toContain(
      "SELECT r.id, r.salon_id, r.name, r.kind, r.display_order",
    );
    expect(view).toContain("r.status = 'active'");
    expect(view).toContain("r.deleted_at IS NULL");
    expect(view).toContain("s.archived_at IS NULL");
    expect(view).toContain("s.profile_complete IS TRUE");
    expect(view).toContain("s.resources_enabled IS TRUE");
    expect(view).not.toContain("square_team_member_id");
    expect(view).not.toContain("same_guest_parallel_capacity");
    expect(view).not.toContain("adjacency_group");
  });

  it("keeps the view read-only and the snapshot on the narrow projection", () => {
    expect(migration).toContain(
      "REVOKE ALL ON TABLE public.public_booking_resource_catalog",
    );
    expect(migration).toContain(
      "GRANT SELECT ON TABLE public.public_booking_resource_catalog",
    );
    expect(migration).toContain(
      "FROM public.public_booking_resource_catalog AS r",
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)[\s\S]*public_booking_resource_catalog/i,
    );
  });

  it("removes the definer-view error without opening the source table", () => {
    expect(hardening).toContain(
      "ALTER VIEW public.public_booking_resource_catalog",
    );
    expect(hardening).toContain("SET (security_invoker = true)");
    expect(hardening).not.toMatch(
      /CREATE\s+POLICY[\s\S]+ON\s+public\.salon_resources/i,
    );
    expect(hardening).not.toMatch(
      /GRANT\s+SELECT[\s\S]+ON\s+(?:TABLE\s+)?public\.salon_resources/i,
    );
  });

  it("uses one narrow stateless-public RPC for the resource projection", () => {
    const helperStart = hardening.indexOf(
      "CREATE OR REPLACE FUNCTION private.public_booking_resources_for_salon",
    );
    const snapshotStart = hardening.indexOf(
      "CREATE OR REPLACE FUNCTION public.load_public_booking_snapshot",
    );
    const helper = hardening.slice(helperStart, snapshotStart);
    const snapshot = hardening.slice(snapshotStart);

    expect(helper).toContain("RETURNS TABLE(");
    expect(helper).toContain("SECURITY DEFINER");
    expect(helper).toContain("SET search_path = ''");
    expect(hardening).toContain("CREATE SCHEMA IF NOT EXISTS private");
    expect(hardening).toContain(
      "REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated, service_role",
    );
    expect(hardening).toContain(
      "GRANT USAGE ON SCHEMA private TO anon, service_role",
    );
    expect(hardening).not.toContain(
      "FUNCTION public.public_booking_resources_for_salon",
    );
    expect(helper).toContain("r.salon_id = p_salon_id");
    expect(helper).toContain("r.status = 'active'");
    expect(helper).toContain("s.profile_complete IS TRUE");
    expect(helper).toContain("s.resources_enabled IS TRUE");
    expect(helper).not.toContain("square_team_member_id");
    expect(helper).not.toContain("same_guest_parallel_capacity");
    expect(helper).not.toContain("adjacency_group");
    expect(hardening).toContain(
      "TO anon, service_role",
    );
    expect(hardening).toContain("FROM PUBLIC, authenticated");
    expect(snapshot).toContain("SECURITY INVOKER");
    expect(snapshot).toContain(
      "FROM private.public_booking_resources_for_salon(s.id) AS r",
    );
    expect(snapshot).not.toContain(
      "FROM public.public_booking_resource_catalog AS r",
    );
  });

  it("provides a rollback-only QA rehearsal for role and publication boundaries", () => {
    expect(rehearsal).toContain("\\set ON_ERROR_STOP on");
    expect(rehearsal).toContain("BEGIN;");
    expect(rehearsal).toContain("SET LOCAL ROLE anon;");
    expect(rehearsal).toContain(
      "pg_catalog.has_schema_privilege('authenticated', 'private', 'USAGE')",
    );
    expect(rehearsal).toContain("security_invoker=true");
    expect(rehearsal).toContain("anon direct resource read bypassed RLS");
    expect(rehearsal).toContain("unpublished salon resources were exposed");
    expect(rehearsal).toContain("SET LOCAL ROLE authenticated;");
    expect(rehearsal).toContain(
      "authenticated direct resource read bypassed RLS",
    );
    expect(rehearsal).toContain(
      "pg_catalog.has_function_privilege(\n       'authenticated', v_snapshot_oid, 'EXECUTE'",
    );
    expect(rehearsal).toContain("ROLLBACK;");
    expect(rehearsal).not.toMatch(/COMMIT\s*;/i);
  });
});
