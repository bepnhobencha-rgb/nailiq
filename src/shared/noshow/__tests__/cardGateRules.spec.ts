import { describe, expect, it } from "vitest";

import {
  isShortNoticeAppointment,
  parseCardGateRules,
} from "@/shared/noshow/cardGateRules";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");

describe("short-notice card gate", () => {
  it("is off by default and clamps configured hours", () => {
    expect(parseCardGateRules({}).shortNoticeHours).toBeNull();
    expect(
      parseCardGateRules({ noshow_short_notice_hours: 999 })
        .shortNoticeHours,
    ).toBe(168);
  });

  it("requires a card at the exact configured boundary", () => {
    expect(
      isShortNoticeAppointment("2026-08-09T12:00:00.000Z", 24, NOW),
    ).toBe(true);
  });

  it("does not require a card outside the window, in the past, or when off", () => {
    expect(
      isShortNoticeAppointment("2026-08-09T12:00:00.001Z", 24, NOW),
    ).toBe(false);
    expect(
      isShortNoticeAppointment("2026-08-08T11:59:59.999Z", 24, NOW),
    ).toBe(false);
    expect(
      isShortNoticeAppointment("2026-08-08T14:00:00.000Z", null, NOW),
    ).toBe(false);
  });
});
