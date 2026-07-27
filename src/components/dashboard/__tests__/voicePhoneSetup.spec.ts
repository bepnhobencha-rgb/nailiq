import { describe, expect, it } from "vitest";
import { formatVoiceUsageResetDate } from "../VoicePhoneSetup";

describe("VoicePhoneSetup reset date", () => {
  it("formats midnight UTC deterministically across server and salon timezones", () => {
    expect(formatVoiceUsageResetDate("2026-07-01T00:00:00.000Z")).toBe("Jul 1");
  });

  it("omits missing or invalid reset dates", () => {
    expect(formatVoiceUsageResetDate(null)).toBeNull();
    expect(formatVoiceUsageResetDate("not-a-date")).toBeNull();
  });
});
