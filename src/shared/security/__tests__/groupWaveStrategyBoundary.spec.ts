import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260830023823_add_group_wave_strategy.sql",
  ),
  "utf8",
);
const parity = readFileSync(
  resolve(process.cwd(), "scripts/check-schema-parity.ts"),
  "utf8",
);
const publicViewRollback = readFileSync(
  resolve(
    process.cwd(),
    "scripts/security/rehearse-public-view-invoker-rollback.sql",
  ),
  "utf8",
);
const salonColumnBoundary = readFileSync(
  resolve(
    process.cwd(),
    "scripts/security/check-salon-column-access-boundary.sql",
  ),
  "utf8",
);

describe("group wave strategy database boundary", () => {
  it("defaults existing salons to the backward-compatible exact policy", () => {
    expect(migration).toContain("default 'maximize_revenue'");
    expect(migration).toContain("salons_group_wave_strategy_check");
    expect(migration).toContain("'balanced'");
    expect(migration).toContain("'on_time'");
  });

  it("exposes only the safe policy through the hardened public view", () => {
    expect(migration).toContain("group_wave_strategy\nfrom public.salons");
    expect(migration).toContain(
      "alter view public.public_salon_profiles set (security_invoker = true)",
    );
    expect(migration).toContain(
      "grant select (group_wave_strategy) on table public.salons",
    );
    expect(migration).toContain(
      "revoke all on table public.public_salon_profiles",
    );
  });

  it("keeps owner/admin settings behind active-session membership checks", () => {
    expect(migration).toContain("public.current_auth_session_is_active()");
    expect(migration).toContain("v_role not in ('owner', 'admin')");
    expect(migration).toContain("'group_wave_strategy', s.group_wave_strategy");
    expect(migration).toContain(
      "grant execute on function public.load_salon_owner_admin_settings(uuid)\n  to authenticated",
    );
  });

  it("advances the blank-database schema tripwire for the base and view columns", () => {
    expect(parity).toContain("20260830023823 Smart Wave strategy migration");
    expect(parity).toContain("columns: 3590");
  });

  it("keeps the emergency public-view rollback complete", () => {
    expect(publicViewRollback).toContain(
      "closure_notice, group_wave_strategy",
    );
  });

  it("keeps owner authorization proof semantic across function formatting", () => {
    expect(salonColumnBoundary).toContain(
      "'for share' IN pg_catalog.lower(v_owner_def)",
    );
    expect(salonColumnBoundary).toContain(
      "'v_role not in (''owner'', ''admin'')'",
    );
    expect(salonColumnBoundary).toContain(
      "'current_auth_session_is_active()' IN v_owner_def",
    );
  });
});
