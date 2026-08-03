import { describe, expect, it } from "vitest";

import { SUPERADMIN_PER_SALON_FLAGS } from "@/shared/superadmin/superadminTypes";

describe("Rule-first feature flag control", () => {
  it("is visible, live, and confirmation-gated in Superadmin", () => {
    const flag = SUPERADMIN_PER_SALON_FLAGS.find(
      (item) => item.key === "ai_rule_first_optimization",
    );

    expect(flag).toMatchObject({
      group: "intelligence",
      phase: "live",
      danger: true,
    });
    expect(flag?.description).toContain("tắt để quay lại cách cũ ngay");
  });
});
