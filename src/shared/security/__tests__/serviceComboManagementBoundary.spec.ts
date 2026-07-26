import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("service combo management authorization boundary", () => {
  it("gates the combos page to owner/admin before feature and catalog reads", () => {
    const page = source("src/app/dashboard/[slug]/combos/page.tsx");
    const roleGuard = page.indexOf("if (!isOwnerOrAdmin(ctx.role))");
    const featureRead = page.indexOf(".from(\"salons\")");
    const comboRead = page.indexOf(".from(\"service_combos\"");

    expect(page).toContain('from "@/shared/lib/salonMemberRole"');
    expect(roleGuard).toBeGreaterThan(-1);
    expect(featureRead).toBeGreaterThan(roleGuard);
    expect(comboRead).toBeGreaterThan(roleGuard);
  });

  it.each(["saveServiceCombo", "deleteServiceCombo"])(
    "guards %s and scopes every combo mutation to the resolved salon",
    (actionName) => {
      const actions = source("src/shared/dashboard/comboActions.ts");
      const actionStart = actions.indexOf(`export async function ${actionName}(`);
      const nextAction = actions.indexOf("\nexport async function ", actionStart + 1);
      const action = actions.slice(actionStart, nextAction < 0 ? undefined : nextAction);
      const roleGuard = action.indexOf("if (!isOwnerOrAdmin(ctx.role))");
      const mutation = Math.min(
        ...[".insert(", ".update(", ".delete("]
          .map((needle) => action.indexOf(needle))
          .filter((index) => index >= 0),
      );

      expect(actionStart).toBeGreaterThan(-1);
      expect(roleGuard).toBeGreaterThan(-1);
      expect(mutation).toBeGreaterThan(roleGuard);
      expect(action.slice(mutation)).toContain('.eq("salon_id", ctx.salon.id)');
    },
  );

  it("keeps the browser component off direct Supabase writes", () => {
    const component = source("src/components/dashboard/CombosPanel.tsx");

    expect(component).not.toContain("createClient");
    expect(component).not.toContain('.from("service_combos"');
    expect(component).toContain("saveServiceCombo(slug");
    expect(component).toContain("deleteServiceCombo(slug");
  });

  it("replaces owner/senior RLS with owner/admin USING and WITH CHECK", () => {
    const migration = source(
      "supabase/migrations/20260723224500_restrict_service_combo_management.sql",
    );

    expect(migration).toContain("drop policy if exists salon_owner_manage_combos");
    expect(migration).toContain("create policy salon_owner_admin_manage_combos");
    expect(migration).toContain("for all");
    expect(migration).toContain("to authenticated");
    expect(migration).toContain("with check");
    expect(migration.match(/sm\.role in \('owner', 'admin'\)/g)).toHaveLength(2);
    expect(migration).not.toContain("drop policy if exists public_read_active_combos");
  });
});
