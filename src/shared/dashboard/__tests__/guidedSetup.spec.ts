import { describe, expect, it } from "vitest";
import type { GoLiveReadiness } from "@/shared/dashboard/goLiveReadiness";
import { deriveGuidedSetupProgress } from "@/shared/dashboard/guidedSetup";

function readiness(
  states: Partial<Record<"identity" | "schedule" | "staff" | "catalog", "pass" | "action">>,
  options?: { readyForManualReview?: boolean; approvedForGoLive?: boolean },
): GoLiveReadiness {
  return {
    checks: (["identity", "schedule", "staff", "catalog"] as const).map(
      (id) => ({
        id,
        state: states[id] ?? "action",
        blocking: true,
        titleEn: id,
        titleVi: id,
        detailEn: `${id} detail`,
        detailVi: `${id} detail`,
        href: `/custom/${id}`,
      }),
    ),
    passedBlocking: Object.values(states).filter((state) => state === "pass")
      .length,
    totalBlocking: 4,
    readyForManualReview: options?.readyForManualReview ?? false,
    approvedForGoLive: options?.approvedForGoLive ?? false,
  };
}

describe("deriveGuidedSetupProgress", () => {
  it("returns only the first incomplete step as the next action", () => {
    const result = deriveGuidedSetupProgress(
      "qa-salon",
      readiness({ identity: "pass", schedule: "action" }),
    );

    expect(result.percent).toBe(20);
    expect(result.currentStepNumber).toBe(2);
    expect(result.nextStep).toMatchObject({
      id: "schedule",
      href: "/custom/schedule",
    });
  });

  it("moves to final review after technical setup passes", () => {
    const result = deriveGuidedSetupProgress(
      "qa salon",
      readiness(
        {
          identity: "pass",
          schedule: "pass",
          staff: "pass",
          catalog: "pass",
        },
        { readyForManualReview: true },
      ),
    );

    expect(result.percent).toBe(80);
    expect(result.nextStep).toMatchObject({
      id: "go-live",
      href: "/dashboard/qa%20salon/settings/readiness",
    });
  });

  it("reports completion only after the current setup is approved", () => {
    const result = deriveGuidedSetupProgress(
      "qa-salon",
      readiness(
        {
          identity: "pass",
          schedule: "pass",
          staff: "pass",
          catalog: "pass",
        },
        { readyForManualReview: true, approvedForGoLive: true },
      ),
    );

    expect(result).toMatchObject({
      complete: true,
      percent: 100,
      completedCount: 5,
      nextStep: null,
    });
  });
});
