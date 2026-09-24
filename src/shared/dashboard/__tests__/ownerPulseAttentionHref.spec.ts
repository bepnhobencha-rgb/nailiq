import { describe, expect, it } from "vitest";
import { ownerPulseAttentionHref } from "../ownerPulseAttentionHref";

describe("owner attention destinations", () => {
  const input = { slug: "test salon", timezone: "America/Los_Angeles", generatedAtUtc: "2026-09-24T01:00:00Z" };
  it("uses the salon date, not UTC or the viewer's date", () => {
    expect(ownerPulseAttentionHref({ ...input, kind: "tomorrow_low" })).toBe("/dashboard/test%20salon/center?view=day&date=2026-09-24");
  });
  it.each([
    ["2026-03-08T08:30:00Z", "2026-03-09"],
    ["2026-11-01T07:30:00Z", "2026-11-02"],
    ["2026-12-31T23:00:00Z", "2027-01-01"],
  ])("handles DST and year rollover %s", (generatedAtUtc, date) => {
    expect(ownerPulseAttentionHref({ ...input, kind: "tomorrow_low", generatedAtUtc })).toContain(`date=${date}`);
  });
  it("retains the waitlist panel destination", () => {
    expect(ownerPulseAttentionHref({ ...input, kind: "waitlist" })).toBe("/dashboard/test%20salon/center?view=day#waitlist");
  });
  it.each(["overdue", "not_started", "no_show_risk"] as const)("keeps %s on today's board", kind => {
    expect(ownerPulseAttentionHref({ ...input, kind })).toBe("/dashboard/test%20salon/center");
  });
});
