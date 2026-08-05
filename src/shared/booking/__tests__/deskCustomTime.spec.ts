import { describe, expect, it } from "vitest";

import { deskCustomTimeLabel } from "@/shared/booking/deskCustomTime";

describe("desk custom appointment time", () => {
  it("preserves off-grid minutes", () => {
    expect(deskCustomTimeLabel("18:35")).toBe("6:35 PM");
  });

  it("handles midnight and noon", () => {
    expect(deskCustomTimeLabel("00:00")).toBe("12:00 AM");
    expect(deskCustomTimeLabel("12:05")).toBe("12:05 PM");
  });

  it("rejects malformed or out-of-range input", () => {
    expect(deskCustomTimeLabel("6:35")).toBeNull();
    expect(deskCustomTimeLabel("24:00")).toBeNull();
    expect(deskCustomTimeLabel("18:60")).toBeNull();
  });
});
