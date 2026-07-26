import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("notification settings authorization boundary", () => {
  it.each([
    [
      "owner notification settings",
      "src/shared/dashboard/ownerNotificationActions.ts",
      "getOwnerNotificationSettings",
      "owner_notification_settings",
    ],
    [
      "staff notification settings",
      "src/shared/dashboard/staffNotificationActions.ts",
      "getStaffNotificationSettings",
      "staff_notification_settings",
    ],
  ])("guards %s reads before accessing salon configuration", (_, path, actionName, column) => {
    const file = source(path);
    const actionStart = file.indexOf(`export async function ${actionName}(`);
    const nextAction = file.indexOf("\nexport async function ", actionStart + 1);
    const action = file.slice(actionStart, nextAction < 0 ? undefined : nextAction);
    const roleGuard = action.indexOf("if (!isOwnerOrAdmin(ctx.role))");
    const settingsRead = action.indexOf(column);

    expect(file).toContain('from "@/shared/lib/salonMemberRole"');
    expect(actionStart).toBeGreaterThan(-1);
    expect(roleGuard).toBeGreaterThan(-1);
    expect(settingsRead).toBeGreaterThan(roleGuard);
  });

  it.each([
    [
      "src/shared/dashboard/ownerNotificationActions.ts",
      ["saveOwnerNotificationSettings", "sendOwnerNotificationTestAction"],
    ],
    [
      "src/shared/dashboard/staffNotificationActions.ts",
      ["saveStaffNotificationSettings"],
    ],
  ])("keeps notification mutations behind the same owner/admin guard", (path, actions) => {
    const file = source(path);

    for (const actionName of actions) {
      const actionStart = file.indexOf(`export async function ${actionName}(`);
      const nextAction = file.indexOf("\nexport async function ", actionStart + 1);
      const action = file.slice(actionStart, nextAction < 0 ? undefined : nextAction);

      expect(actionStart).toBeGreaterThan(-1);
      expect(action).toContain("if (!isOwnerOrAdmin(ctx.role))");
    }
  });
});
