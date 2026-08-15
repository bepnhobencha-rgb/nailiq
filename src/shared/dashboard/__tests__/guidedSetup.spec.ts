import { describe, expect, it } from "vitest";
import type {
  GoLiveReadiness,
  GoLiveReadinessState,
} from "@/shared/dashboard/goLiveReadiness";
import {
  canOpenGuidedStep,
  deriveGuidedSetupProgress,
  shouldUseGuidedFocusMode,
} from "@/shared/dashboard/guidedSetup";

const CHECK_IDS = [
  "identity",
  "schedule",
  "hours-confirmation",
  "staff",
  "catalog",
  "booking-policy",
  "fallback-channel",
  "notification-language",
  "otp-policy",
  "optional-integrations",
  "public-booking",
  "human-approval",
  "owner-approval",
] as const;

function readiness(
  states: Partial<Record<(typeof CHECK_IDS)[number], GoLiveReadinessState>>,
  options?: { approvedForGoLive?: boolean },
): GoLiveReadiness {
  return {
    checks: CHECK_IDS.map((id) => ({
      id,
      state: states[id] ?? "action",
      blocking: ["identity", "schedule", "staff", "catalog", "public-booking"].includes(id),
      titleEn: id,
      titleVi: id,
      detailEn: `${id} detail`,
      detailVi: `${id} detail`,
      href: `/custom/${id}`,
    })),
    passedBlocking: 0,
    totalBlocking: 5,
    readyForManualReview: false,
    approvedForGoLive: options?.approvedForGoLive ?? false,
  };
}

const firstSixPass = {
  identity: "pass",
  schedule: "pass",
  "hours-confirmation": "pass",
  staff: "pass",
  catalog: "pass",
  "booking-policy": "pass",
  "fallback-channel": "pass",
  "notification-language": "pass",
  "otp-policy": "pass",
} as const;

describe("deriveGuidedSetupProgress", () => {
  it("returns only the first incomplete required step as the next action", () => {
    const result = deriveGuidedSetupProgress(
      "qa-salon",
      readiness({ identity: "pass", schedule: "action" }),
    );

    expect(result).toMatchObject({
      percent: 13,
      completedCount: 1,
      requiredCount: 8,
      currentStepNumber: 2,
      totalStepCount: 9,
    });
    expect(result.nextStep).toMatchObject({
      id: "business-hours",
      href: "/dashboard/qa-salon/setup/hours",
    });
  });

  it("skips the optional integration step without counting it as completed", () => {
    const result = deriveGuidedSetupProgress(
      "qa salon",
      readiness({
        ...firstSixPass,
        "optional-integrations": "review",
        "public-booking": "action",
      }),
    );

    expect(result).toMatchObject({
      percent: 75,
      completedCount: 6,
      requiredCount: 8,
      currentStepNumber: 8,
    });
    expect(result.nextStep).toMatchObject({
      id: "booking-preview",
      href: "/dashboard/qa%20salon/setup/preview",
    });
  });

  it("keeps preview incomplete until an authorized rehearsal is recorded", () => {
    const result = deriveGuidedSetupProgress(
      "qa-salon",
      readiness({
        identity: "pass",
        schedule: "pass",
        staff: "pass",
        catalog: "pass",
        "booking-policy": "pass",
        "fallback-channel": "pass",
        "notification-language": "pass",
        "public-booking": "pass",
        "hours-confirmation": "review",
        "otp-policy": "review",
        "human-approval": "review",
        "owner-approval": "review",
      }),
    );

    expect(result).toMatchObject({
      percent: 75,
      completedCount: 6,
      requiredCount: 8,
      currentStepNumber: 8,
      nextStep: { id: "booking-preview" },
      complete: false,
    });
  });

  it("moves to final Go-Live only after the saved public gate and rehearsal pass", () => {
    const result = deriveGuidedSetupProgress(
      "qa-salon",
      readiness({
        identity: "pass",
        schedule: "pass",
        staff: "pass",
        catalog: "pass",
        "booking-policy": "pass",
        "fallback-channel": "pass",
        "notification-language": "pass",
        "public-booking": "pass",
        "human-approval": "pass",
        "hours-confirmation": "review",
        "otp-policy": "review",
        "owner-approval": "review",
      }),
    );

    expect(result).toMatchObject({
      percent: 88,
      currentStepNumber: 9,
      nextStep: { id: "go-live" },
    });
  });

  it("does not report completion when a required policy check is missing", () => {
    const result = deriveGuidedSetupProgress(
      "qa-salon",
      readiness(
        Object.fromEntries(CHECK_IDS.map((id) => [id, "pass"])) as Record<
          (typeof CHECK_IDS)[number],
          "pass"
        >,
        { approvedForGoLive: true },
      ),
    );
    const missingPolicy = deriveGuidedSetupProgress(
      "qa-salon",
      readiness(
        {
          ...Object.fromEntries(CHECK_IDS.map((id) => [id, "pass"])),
          "booking-policy": "action",
        },
        { approvedForGoLive: true },
      ),
    );

    expect(result).toMatchObject({
      complete: true,
      percent: 100,
      completedCount: 8,
      nextStep: null,
    });
    expect(missingPolicy).toMatchObject({
      complete: false,
      nextStep: { id: "booking-policies" },
    });
  });
});

describe("shouldUseGuidedFocusMode", () => {
  it("focuses every incomplete setup route and only the completed root Action Center", () => {
    expect(shouldUseGuidedFocusMode("disabled", null)).toBe(false);
    expect(shouldUseGuidedFocusMode("incomplete", null)).toBe(true);
    expect(shouldUseGuidedFocusMode("incomplete", "services")).toBe(true);
    expect(shouldUseGuidedFocusMode("complete", null)).toBe(true);
    expect(shouldUseGuidedFocusMode("complete", "center")).toBe(false);
    expect(shouldUseGuidedFocusMode("complete", "settings")).toBe(false);
  });
});

describe("canOpenGuidedStep", () => {
  it("keeps exactly one forward action", () => {
    const progress = deriveGuidedSetupProgress(
      "qa-salon",
      readiness({ identity: "pass", schedule: "action" }),
    );

    expect(canOpenGuidedStep(progress.steps, 0, progress.nextStep)).toBe(false);
    expect(canOpenGuidedStep(progress.steps, 1, progress.nextStep)).toBe(true);
    expect(canOpenGuidedStep(progress.steps, 2, progress.nextStep)).toBe(false);
    expect(canOpenGuidedStep(progress.steps, 6, progress.nextStep)).toBe(false);
  });

  it("explicitly skips the optional integration row while the next required action stays open", () => {
    const progress = deriveGuidedSetupProgress(
      "qa-salon",
      readiness({
        ...firstSixPass,
        "optional-integrations": "review",
        "public-booking": "action",
      }),
    );

    expect(canOpenGuidedStep(progress.steps, 6, progress.nextStep)).toBe(false);
    expect(canOpenGuidedStep(progress.steps, 7, progress.nextStep)).toBe(true);
    expect(canOpenGuidedStep(progress.steps, 8, progress.nextStep)).toBe(false);
  });
});
