import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("public page management authorization boundary", () => {
  it.each([
    "src/app/dashboard/[slug]/settings/my-page/page.tsx",
    "src/app/dashboard/[slug]/import/page.tsx",
  ])("keeps %s owner/admin-only before privileged reads", (path) => {
    const page = source(path);
    const roleGuard = page.indexOf("if (!isOwnerOrAdmin(ctx.role)) redirect(");
    const privilegedRead = Math.min(
      ...[".from(", ".rpc(", "createServiceRoleClient()"]
        .map((needle) => page.indexOf(needle))
        .filter((index) => index >= 0),
    );

    expect(page).toContain('from "@/shared/lib/salonMemberRole"');
    expect(roleGuard).toBeGreaterThan(-1);
    expect(privilegedRead).toBeGreaterThan(roleGuard);
  });

  it("guards the website import API before creating a service-role client", () => {
    const route = source("src/app/api/import-website/route.ts");
    const roleGuard = route.indexOf("if (!isOwnerOrAdmin(ctx.role))");
    const serviceRole = route.indexOf("const db = createServiceRoleClient()");

    expect(roleGuard).toBeGreaterThan(-1);
    expect(route.slice(roleGuard, serviceRole)).toContain('status: 403');
    expect(serviceRole).toBeGreaterThan(roleGuard);
  });

  it.each(["updateSectionOrder", "uploadSectionImage"])(
    "guards %s before its first write",
    (actionName) => {
      const actions = source("src/shared/dashboard/pageEditorActions.ts");
      const actionStart = actions.indexOf(`export async function ${actionName}(`);
      const nextAction = actions.indexOf("\nexport async function ", actionStart + 1);
      const action = actions.slice(actionStart, nextAction < 0 ? undefined : nextAction);

      expect(actionStart).toBeGreaterThan(-1);
      expect(action).toContain("if (!isOwnerOrAdmin(ctx.role))");
      expect(action.indexOf("if (!isOwnerOrAdmin(ctx.role))")).toBeLessThan(
        action.indexOf(actionName === "updateSectionOrder" ? ".update(" : ".upload("),
      );
    },
  );

  it("replaces member-wide RLS with owner/admin policies using USING and WITH CHECK", () => {
    const migration = source(
      "supabase/migrations/20260723222235_restrict_public_page_management.sql",
    );

    expect(migration).toContain("drop policy if exists salon_member_rw");
    expect(migration).toContain("drop policy if exists salon_member_all");
    expect(migration.match(/create policy salon_owner_admin_manage/g)).toHaveLength(2);
    expect(migration.match(/to authenticated/g)).toHaveLength(2);
    expect(migration.match(/with check/g)).toHaveLength(2);
    expect(migration.match(/sm\.role in \('owner', 'admin'\)/g)).toHaveLength(4);
    expect(migration).not.toContain("drop policy if exists salon_page_sections_public_read");
  });
});
