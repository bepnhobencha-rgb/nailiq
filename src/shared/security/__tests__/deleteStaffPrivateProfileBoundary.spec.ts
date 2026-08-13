import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deleteStaff private client-profile cleanup", () => {
  it("uses the server-only client and the verified target staff UUID", () => {
    const source = readFileSync(
      new URL("../../dashboard/setupActions.ts", import.meta.url),
      "utf8",
    );
    const deleteStaff = source.slice(
      source.indexOf("export async function deleteStaff"),
      source.indexOf("export async function updateOpeningHours"),
    );

    expect(deleteStaff).toContain("const admin = createServiceRoleClient()");
    expect(deleteStaff).toContain('admin\n    .from("bookings")');
    expect(deleteStaff).toContain('.from("client_profiles")');
    expect(deleteStaff).toContain('admin\n    .from("staff")');
    const preferenceCleanup = deleteStaff.slice(
      deleteStaff.indexOf('.from("client_profiles")'),
      deleteStaff.indexOf("if (prefErr)"),
    );
    expect(preferenceCleanup).toContain('.eq("preferred_staff_id", staffId)');
    expect(preferenceCleanup).not.toContain('.eq("salon_id"');
  });
});
