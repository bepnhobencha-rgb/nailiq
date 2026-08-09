import { describe, expect, it } from "vitest";
import {
  applyVipEmailSuppression,
  buildVipActionDedupeKeys,
} from "@/shared/ai/vipCareDelivery";

describe("VIP Care email suppression", () => {
  it("fails closed when email is the only delivery channel", () => {
    expect(
      applyVipEmailSuppression(
        { sms: false, email: true, noChannel: false, reason: "email_only" },
        true,
      ),
    ).toEqual({
      sms: false,
      email: false,
      noChannel: true,
      reason: "email_suppressed",
    });
  });

  it("preserves an independently permitted SMS channel", () => {
    expect(
      applyVipEmailSuppression(
        { sms: true, email: true, noChannel: false, reason: "smart_both" },
        true,
      ),
    ).toEqual({
      sms: true,
      email: false,
      noChannel: false,
      reason: "smart_both_email_suppressed",
    });
  });

  it("does not alter an unsuppressed decision", () => {
    const decision = {
      sms: false,
      email: true,
      noChannel: false,
      reason: "email_only",
    };
    expect(applyVipEmailSuppression(decision, false)).toBe(decision);
  });
});

describe("buildVipActionDedupeKeys", () => {
  const now = new Date("2026-08-08T12:00:00.000Z");

  it("keeps an old milestone blocked forever", () => {
    const keys = buildVipActionDedupeKeys(
      [{
        action_type: "milestone_10",
        target_id: "client-1",
        created_at: "2024-01-01T00:00:00.000Z",
      }],
      now,
    );

    expect(keys.has("milestone_10:client-1")).toBe(true);
  });

  it("only blocks this year's birthday and the current inactive window", () => {
    const keys = buildVipActionDedupeKeys(
      [
        {
          action_type: "birthday",
          target_id: "old-birthday",
          created_at: "2025-12-31T23:59:59.000Z",
        },
        {
          action_type: "birthday",
          target_id: "current-birthday",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          action_type: "vip_inactive",
          target_id: "old-inactive",
          created_at: "2026-07-01T00:00:00.000Z",
        },
        {
          action_type: "vip_inactive",
          target_id: "current-inactive",
          created_at: "2026-07-20T00:00:00.000Z",
        },
      ],
      now,
    );

    expect(keys).toEqual(new Set([
      "birthday:current-birthday",
      "vip_inactive:current-inactive",
    ]));
  });
});
