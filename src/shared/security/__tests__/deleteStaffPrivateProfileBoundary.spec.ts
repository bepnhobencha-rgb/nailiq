import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deleteStaff atomic offboarding boundary", () => {
  it("scans both scheduling models and refuses the legacy destructive path", () => {
    const source = readFileSync(
      new URL("../../dashboard/setupActions.ts", import.meta.url),
      "utf8",
    );
    const deleteStaff = source.slice(
      source.indexOf("export async function deleteStaff"),
      source.indexOf("export async function updateOpeningHours"),
    );

    expect(source).toContain("loadLiveStaffAssignmentState");
    expect(source).toContain('.from("booking_service_segments")');
    expect(deleteStaff).toContain('fail("staff_offboarding_required")');
    expect(deleteStaff).not.toContain('from("client_profiles")');
    expect(deleteStaff).not.toContain("deleted_at: new Date()");
    expect(deleteStaff).toContain('.eq("salon_id", r.salon.id)');
  });
});
