import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deleteStaff private client-profile cleanup", () => {
  it("uses the server-only client after proving the target staff UUID belongs to the salon", () => {
    const source = readFileSync(
      new URL("../../dashboard/setupActions.ts", import.meta.url),
      "utf8",
    );
    const deleteStaff = source.slice(
      source.indexOf("export async function deleteStaff"),
      source.indexOf("export async function updateOpeningHours"),
    );

    expect(deleteStaff).toContain("const admin = createServiceRoleClient()");
    expect(deleteStaff).not.toMatch(
      /\.from\("bookings"\)[\s\S]*?\.update\(\{ staff_id: null \}\)/,
    );
    expect(deleteStaff).toContain(
      "cancelled/no-show rows are immutable tombstones",
    );
    expect(deleteStaff).toContain('.from("client_profiles")');
    expect(deleteStaff).toContain('admin\n    .from("staff")');
    expect(deleteStaff).toContain('.eq("id", staffId)');
    expect(deleteStaff).toContain('.eq("salon_id", r.salon.id)');
    expect(deleteStaff).toContain('if (!mine?.id) return fail("not_found")');
    const preferenceCleanup = deleteStaff.slice(
      deleteStaff.indexOf('.from("client_profiles")'),
      deleteStaff.indexOf("if (prefErr)"),
    );
    expect(preferenceCleanup).toContain('.eq("preferred_staff_id", staffId)');
    expect(preferenceCleanup).not.toContain('.eq("salon_id"');
  });
});
