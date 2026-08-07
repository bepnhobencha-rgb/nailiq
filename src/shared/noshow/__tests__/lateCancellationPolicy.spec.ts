import { describe, expect, it } from "vitest";
import {
  buildLateCancellationLockPatch,
  evaluateLateCancellationPolicy,
} from "@/shared/noshow/lateCancellationPolicy";

const NOW = Date.parse("2026-08-07T12:00:00.000Z");
const salon = {
  selfCancelFeeEnabled: true,
  selfCancelWindowHours: 24,
  selfCancelFeePercent: 10,
  noShowFeePercent: 20,
};

function booking(overrides: Partial<Parameters<typeof evaluateLateCancellationPolicy>[0]["booking"]> = {}) {
  return {
    startTimeUtc: "2026-08-09T12:00:00.000Z",
    noShowFeeCents: 4_000,
    noShowCardId: "card_test",
    noShowConsentAt: "2026-08-01T12:00:00.000Z",
    noShowChargeStatus: "saved",
    selfCancelFeeLockedAt: null,
    selfCancelFeeLockedCents: null,
    ...overrides,
  };
}

describe("late cancellation policy", () => {
  it("keeps the exact 24-hour boundary fee-free", () => {
    const result = evaluateLateCancellationPolicy({
      booking: booking({ startTimeUtc: "2026-08-08T12:00:00.000Z" }),
      salon,
      nowMs: NOW,
    });

    expect(result.withinWindow).toBe(false);
    expect(result.willCharge).toBe(false);
  });

  it("charges the gentler 10% fee inside the 24-hour window", () => {
    const result = evaluateLateCancellationPolicy({
      booking: booking({ startTimeUtc: "2026-08-08T11:59:59.000Z" }),
      salon,
      nowMs: NOW,
    });

    expect(result.withinWindow).toBe(true);
    expect(result.feeCents).toBe(2_000);
    expect(result.willCharge).toBe(true);
  });

  it("preserves a locked fee after the customer moves the appointment farther away", () => {
    const result = evaluateLateCancellationPolicy({
      booking: booking({
        startTimeUtc: "2026-09-01T12:00:00.000Z",
        selfCancelFeeLockedAt: "2026-08-07T12:00:00.000Z",
        selfCancelFeeLockedCents: 2_000,
      }),
      salon,
      nowMs: NOW,
    });

    expect(result.currentWithinWindow).toBe(false);
    expect(result.policyLockedByReschedule).toBe(true);
    expect(result.withinWindow).toBe(true);
    expect(result.feeCents).toBe(2_000);
    expect(result.willCharge).toBe(true);
  });

  it("never charges without a saved card and recorded consent", () => {
    const result = evaluateLateCancellationPolicy({
      booking: booking({
        startTimeUtc: "2026-08-08T11:00:00.000Z",
        noShowCardId: null,
      }),
      salon,
      nowMs: NOW,
    });

    expect(result.withinWindow).toBe(true);
    expect(result.hasChargeableCard).toBe(false);
    expect(result.willCharge).toBe(false);
  });

  it("builds one immutable lock only for a customer-controlled late reschedule", () => {
    const patch = buildLateCancellationLockPatch({
      previousStartTimeUtc: "2026-08-08T11:00:00.000Z",
      noShowFeeCents: 4_000,
      salon,
      reason: "voice_reschedule",
      nowMs: NOW,
    });

    expect(patch).toEqual({
      self_cancel_fee_locked_at: "2026-08-07T12:00:00.000Z",
      self_cancel_fee_locked_cents: 2_000,
      self_cancel_fee_lock_reason: "voice_reschedule",
    });
    expect(
      buildLateCancellationLockPatch({
        previousStartTimeUtc: "2026-08-08T11:00:00.000Z",
        noShowFeeCents: 4_000,
        existingLockedAt: "2026-08-07T11:00:00.000Z",
        existingLockedCents: 2_000,
        salon,
        reason: "voice_reschedule",
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("honours an emergency salon policy disable even when a booking is locked", () => {
    const result = evaluateLateCancellationPolicy({
      booking: booking({
        startTimeUtc: "2026-09-01T12:00:00.000Z",
        selfCancelFeeLockedAt: "2026-08-07T12:00:00.000Z",
        selfCancelFeeLockedCents: 2_000,
      }),
      salon: { ...salon, selfCancelFeeEnabled: false },
      nowMs: NOW,
    });

    expect(result.withinWindow).toBe(true);
    expect(result.willCharge).toBe(false);
  });
});
