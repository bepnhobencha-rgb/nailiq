import { describe, expect, it } from "vitest";

import { formatBookingManagementTime, isValidIanaTimeZone } from "../bookingManagementTime";

describe("booking management salon-local time", () => {
  it("renders one UTC instant differently in each salon timezone", () => {
    const instant = "2099-08-20T17:00:00.000Z";
    expect(formatBookingManagementTime(instant, "America/Los_Angeles")).toContain("10:00 AM");
    expect(formatBookingManagementTime(instant, "Asia/Tokyo")).toContain("2:00 AM");
  });

  it("fails closed instead of silently using the viewer timezone", () => {
    expect(isValidIanaTimeZone("viewer-local")).toBe(false);
    expect(formatBookingManagementTime("2099-08-20T17:00:00.000Z", "viewer-local")).toBeNull();
  });
});
