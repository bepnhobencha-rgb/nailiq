import { describe, expect, it } from "vitest";
import { formatStaffJobRole } from "@/shared/booking/staffJobRoleLabel";

describe("formatStaffJobRole", () => {
  it("localizes platform roles for Vietnamese booking", () => {
    expect(formatStaffJobRole("owner", undefined, "vi")).toBe("Chủ tiệm");
    expect(formatStaffJobRole("senior", undefined, "vi")).toBe("Thợ chính");
    expect(formatStaffJobRole("nail_tech", undefined, "vi")).toBe("Thợ nail");
  });

  it("preserves vertical-specific labels and English defaults", () => {
    expect(formatStaffJobRole("nail_tech", "Kỹ thuật viên", "vi")).toBe(
      "Kỹ thuật viên",
    );
    expect(formatStaffJobRole("owner")).toBe("Owner");
  });
});
