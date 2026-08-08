import { describe, expect, it } from "vitest";

import { selectSalonRelatedManualVipIds } from "@/shared/ai/vipCareIsolation";

describe("VIP Care tenant isolation", () => {
  it("excludes global manual VIPs with no relationship to the salon", () => {
    expect(selectSalonRelatedManualVipIds({
      manualVipIds: ["vip-other-salon"],
      spendProfileIds: [],
      bookingProfileIds: [],
      squareVisitProfileIds: [],
    })).toEqual(new Set());
  });

  it("accepts a manual VIP only through this salon's durable relationship", () => {
    expect(selectSalonRelatedManualVipIds({
      manualVipIds: ["via-spend", "via-booking", "via-square", "unrelated"],
      spendProfileIds: ["via-spend"],
      bookingProfileIds: ["via-booking"],
      squareVisitProfileIds: ["via-square"],
    })).toEqual(new Set(["via-spend", "via-booking", "via-square"]));
  });

  it("never imports non-VIP relationship rows", () => {
    expect(selectSalonRelatedManualVipIds({
      manualVipIds: ["manual-vip"],
      spendProfileIds: ["not-manual-vip"],
      bookingProfileIds: ["not-manual-vip"],
      squareVisitProfileIds: ["not-manual-vip"],
    })).toEqual(new Set());
  });
});
