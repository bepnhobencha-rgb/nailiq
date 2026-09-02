import { describe, expect, it } from "vitest";

import type { TurnIqGroupTimingSimulationRecord } from "@/shared/turniq/contracts";
import { salonAGroupInputFixture } from "@/shared/turniq/fixtures/salonA";
import {
  projectTurnIqGroupPlan,
  projectTurnIqGroupTimingSimulation,
} from "@/shared/turniq/groupReadModels";

describe("TurnIQ group plan privacy-safe projection", () => {
  it("shows operational assignments without internal fairness or customer PII", () => {
    const view = projectTurnIqGroupPlan({
      plan: {
        id: "plan-1",
        bookingGroupId: "group-1",
        partySize: 2,
        requestedStartAt: "2026-09-02T16:30:00.000Z",
        decisionTimestamp: "2026-09-02T16:00:00.000Z",
        privacySafeExplanation: "Recommend Anh and Binh: both are available and qualified.",
        conservativeEta: {
          earliestStartMinutes: 0,
          allStartedByMinutes: 5,
          confidencePaddingMinutes: 5,
        },
        status: "recommended",
        stateVersion: 1,
        planningMode: "fixed",
        timingIntent: null,
      },
      items: [
        {
          assignmentId: "assignment-a",
          bookingId: "booking-a",
          staffId: "staff-a",
          serviceId: "service-a",
          resourceId: "chair-a",
          startsAt: "2026-09-02T16:30:00.000Z",
          safeEndAt: "2026-09-02T17:00:00.000Z",
          requestedFallback: false,
          waitMinutes: 0,
          assignmentStatus: "recommended",
          fairnessReceiptId: null,
          waveNumber: null,
        },
      ],
      staff: [{ id: "staff-a", name: "Anh" }],
      services: [{ id: "service-a", name: "Classic" }],
      resources: [{ id: "chair-a", name: "Chair 1" }],
    });

    expect(view.canConfirm).toBe(true);
    expect(view.ownerActionRequired).toBe(false);
    expect(view.assignments[0]).toMatchObject({
      staff: { name: "Anh" },
      service: { name: "Classic" },
      resource: { name: "Chair 1" },
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("fairnessCost");
    expect(serialized).not.toContain("serviceCreditSinceCheckInCents");
    expect(serialized).not.toContain("tip");
    expect(serialized).not.toContain("clientPhone");
    expect(serialized).not.toContain("decisionFingerprint");
  });

  it("requires explicit desk action for requested-tech fallback", () => {
    const view = projectTurnIqGroupPlan({
      plan: {
        id: "plan-2",
        bookingGroupId: "group-2",
        partySize: 2,
        requestedStartAt: "2026-09-02T16:30:00.000Z",
        decisionTimestamp: "2026-09-02T16:00:00.000Z",
        privacySafeExplanation: "One requested technician is unavailable.",
        conservativeEta: {},
        status: "recommended",
        stateVersion: 1,
        planningMode: "fixed",
        timingIntent: null,
      },
      items: [
        {
          assignmentId: "assignment-a",
          bookingId: "booking-a",
          staffId: "staff-a",
          serviceId: "service-a",
          resourceId: null,
          startsAt: "2026-09-02T16:30:00.000Z",
          safeEndAt: "2026-09-02T17:00:00.000Z",
          requestedFallback: true,
          waitMinutes: 0,
          assignmentStatus: "recommended",
          fairnessReceiptId: null,
          waveNumber: null,
        },
      ],
      staff: [],
      services: [],
      resources: [],
    });
    expect(view.ownerActionRequired).toBe(true);
    expect(view.canConfirm).toBe(false);
  });

  it("projects timing simulation without peer money or internal trace", () => {
    const decisionInput = structuredClone(salonAGroupInputFixture);
    const simulation: TurnIqGroupTimingSimulationRecord = {
      simulationId: "simulation-1",
      salonId: decisionInput.request.salonId,
      policyId: decisionInput.policy.policyId,
      policyVersion: decisionInput.policy.version,
      snapshotVersion: decisionInput.snapshot.snapshotVersion,
      simulatedAt: decisionInput.snapshot.capturedAt,
      fingerprint: "server-only-fingerprint",
      intent: "smart_wave",
      liveStateChanged: false,
      assignments: [
        {
          taskId: decisionInput.request.tasks[0].taskId,
          staffId: decisionInput.snapshot.candidates[0].staffId,
          startsAt: "2026-09-02T18:00:00.000Z",
          releasesAt: "2026-09-02T19:10:00.000Z",
          resourceIds: ["pedicure-chair-01"],
          waitMinutes: 0,
          requestedTechnicianSatisfied: null,
          reasonCodes: ["GROUP_APPOINTMENT_SAFE", "GROUP_RESOURCE_ASSIGNED"],
          waveNumber: 1,
        },
      ],
      objectiveScore: {
        requestedFallbackCount: 0,
        appointmentSafetyCostMinutes: 0,
        maximumWaitMinutes: 0,
        totalWaitMinutes: 0,
        fairnessTierCost: 0,
        queueCost: 1,
        stableTieBreakKey: "internal-key",
        waveCount: 1,
        latestReleaseMinutes: 70,
      },
      reasonCodes: ["TIMING_SIMULATION_ONLY", "TIMING_COMPLETE_PLAN"],
      conservativeEta: {
        earliestStartMinutes: 0,
        allStartedByMinutes: 15,
        confidencePaddingMinutes: 15,
      },
      privacySafeExplanation: "Simulation only.",
      ownerActionRequired: false,
      evaluatedSearchStates: 10,
    };
    const view = projectTurnIqGroupTimingSimulation({
      simulation,
      decisionInput,
    });

    expect(view.liveStateChanged).toBe(false);
    expect(view.intent).toBe("smart_wave");
    expect(view.assignments).toHaveLength(1);
    expect(view.assignments[0]).toMatchObject({
      serviceSummary: "Deluxe Pedicure",
      resourceNames: ["pedicure-chair"],
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toMatch(
      /fairnessTierCost|queueCost|stableTieBreakKey|serviceCreditSinceCheckInCents|tip|clientPhone|decisionFingerprint/i,
    );
  });
});
