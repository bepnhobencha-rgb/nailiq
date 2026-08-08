import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ruleFirstOptimizationEnabled } from "@/shared/ai/executionLimit";
import { shouldUseAiDigest } from "@/shared/ai/agentDigest";
import {
  clampAndGuard,
  guardPolicyDelta,
  isNoShowPolicyAmbiguous,
  type PolicyContext,
} from "@/shared/noshow/agentNoShowPolicy";
import { hasMaterialWatchdogSignal } from "@/shared/watchdog/agentWatchdog";

const policyContext = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  bookingId: "booking-1",
  salonId: "11111111-1111-4111-8111-111111111111",
  clientName: "Guest",
  serviceName: "Manicure",
  priceCents: 5000,
  startTimeUtc: "2026-08-04T17:00:00.000Z",
  channel: "online",
  hasEmail: true,
  hasPhone: true,
  hasCardOnFile: false,
  hasActiveDeposit: false,
  leadTimeHours: 48,
  isNew: false,
  visitCount: 3,
  noShowCount: 0,
  isVip: false,
  vertical: "nail salon",
  protectionEnabled: true,
  providerConnected: true,
  defaultFeePercent: 20,
  maxFeePercent: 50,
  aiShadowEnabled: false,
  aiLiveEnabled: true,
  ruleFirstOptimizationEnabled: true,
  language: "en",
  isGroupBooking: false,
  partySize: 1,
  partyTotalCents: 5000,
  wholePartyFee: true,
  ...overrides,
});

describe("rule-first AI optimization", () => {
  it("is rollbackable and only activates on an explicit salon flag", () => {
    expect(ruleFirstOptimizationEnabled(undefined)).toBe(false);
    expect(ruleFirstOptimizationEnabled({ ai_rule_first_optimization: false })).toBe(false);
    expect(ruleFirstOptimizationEnabled({ ai_rule_first_optimization: true })).toBe(true);
  });

  it("reserves no-show policy AI for the ambiguous deterministic band", () => {
    expect(isNoShowPolicyAmbiguous(policyContext())).toBe(false);
    expect(isNoShowPolicyAmbiguous(policyContext({ isNew: true, hasEmail: false }))).toBe(true);
    expect(isNoShowPolicyAmbiguous(policyContext({ isVip: true, isNew: true, hasEmail: false }))).toBe(false);
    expect(isNoShowPolicyAmbiguous(policyContext({ isNew: true, hasEmail: false, hasCardOnFile: true }))).toBe(false);
    expect(isNoShowPolicyAmbiguous(policyContext({ isNew: true, hasEmail: false, hasActiveDeposit: true }))).toBe(false);
  });

  it("never asks twice when a booking already has card or deposit protection", () => {
    const ai = {
      protection: "card" as const,
      feePercent: 50,
      reason: "risk",
      message: "Please save a card",
      confidence: "high" as const,
    };

    expect(clampAndGuard(ai, policyContext({ hasCardOnFile: true }))).toMatchObject({
      protection: "none",
      feePercent: 0,
      message: null,
    });
    expect(clampAndGuard(ai, policyContext({ hasActiveDeposit: true }))).toMatchObject({
      protection: "none",
      feePercent: 0,
      message: null,
    });
  });

  it("keeps money policy deterministic and rejects an unsupported AI deposit", () => {
    expect(clampAndGuard({
      protection: "card",
      feePercent: 50,
      reason: "risk",
      message: "Please save a card",
      confidence: "high",
    }, policyContext({ defaultFeePercent: 17 }))).toMatchObject({
      protection: "card",
      feePercent: 17,
    });

    expect(clampAndGuard({
      protection: "deposit",
      feePercent: 50,
      reason: "risk",
      message: "Please pay",
      confidence: "high",
    }, policyContext())).toBeNull();
  });

  it("never weakens the hard rule and requires high confidence for added friction", () => {
    const none = {
      protection: "none" as const,
      feePercent: 0,
      reason: "trust",
      message: null,
      confidence: "high" as const,
    };
    const mediumCard = {
      protection: "card" as const,
      feePercent: 20,
      reason: "uncertain",
      message: "Please save a card",
      confidence: "medium" as const,
    };
    const highCard = { ...mediumCard, confidence: "high" as const };

    expect(guardPolicyDelta(none, "card")).toBeNull();
    expect(guardPolicyDelta(mediumCard, "none")).toBeNull();
    expect(guardPolicyDelta(highCard, "none")).toEqual(highCard);
  });

  it("uses an AI digest only when owner judgment adds value", () => {
    expect(shouldUseAiDigest({
      agentActionCount: 0,
      alertCount: 0,
      pendingApprovalCount: 0,
      unclosedCount: 0,
    })).toBe(false);
    expect(shouldUseAiDigest({
      agentActionCount: 0,
      alertCount: 1,
      pendingApprovalCount: 0,
      unclosedCount: 0,
    })).toBe(true);
  });

  it("does not call watchdog AI for an ordinary stable snapshot", () => {
    const stable = {
      salonId: "11111111-1111-4111-8111-111111111111",
      salonName: "Salon",
      noShow7d: 1,
      noShowPrev7d: 1,
      noShowWithCard7d: 1,
      created7d: 20,
      createdPrev7d: 20,
      tomorrowBooked: 5,
      next7dBooked: 30,
      upcomingHighRiskUnprotected: 0,
      syncError: null,
      syncStaleMinutes: 30,
    };
    expect(hasMaterialWatchdogSignal(stable)).toBe(false);
    expect(hasMaterialWatchdogSignal({ ...stable, syncError: "sync_failed" })).toBe(true);
    expect(hasMaterialWatchdogSignal({ ...stable, noShow7d: 4, noShowPrev7d: 1 })).toBe(true);
  });
});
