import { describe, expect, it } from "vitest";
import type {
  GoLiveReadiness,
  GoLiveReadinessState,
} from "@/shared/dashboard/goLiveReadiness";
import { deriveGuidedSetupProgress } from "@/shared/dashboard/guidedSetup";

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

  it("keeps human attestations in the final Go-Live step instead of trapping earlier setup steps", () => {
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
      percent: 88,
      completedCount: 7,
      requiredCount: 8,
      currentStepNumber: 9,
      nextStep: { id: "go-live" },
      complete: false,
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
