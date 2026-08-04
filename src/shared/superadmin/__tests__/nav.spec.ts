import { describe, expect, it } from "vitest";
import { SUPERADMIN_NAV, isPlaceholder } from "@/shared/superadmin/nav";

describe("SuperAdmin information architecture", () => {
  it("shows only production-ready top-level tools", () => {
    const visible = SUPERADMIN_NAV.filter((item) => !item.mvpHidden);

    expect(visible.map((item) => item.key)).toEqual([
      "dashboard",
      "salons",
      "users",
      "operations",
      "support",
      "ai",
      "security",
      "settings",
    ]);
    expect(visible.some(isPlaceholder)).toBe(false);
  });

  it("keeps unfinished analytics and billing sections out of navigation", () => {
    const hidden = SUPERADMIN_NAV.filter((item) => item.mvpHidden);

    expect(hidden.map((item) => item.key)).toEqual(["analytics", "billing"]);
    expect(hidden.every(isPlaceholder)).toBe(true);
  });
});
