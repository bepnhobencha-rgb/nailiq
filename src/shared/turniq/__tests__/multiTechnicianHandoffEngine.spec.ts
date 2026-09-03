import { describe, expect, it } from "vitest";

import type {
  TurnIqCandidateInput,
  TurnIqHandoffDecisionInput,
  TurnIqHandoffSegmentInput,
} from "@/shared/turniq/contracts";
import { salonATurnPolicyFixture } from "@/shared/turniq/fixtures/salonA";
import { decideTurnIqMultiTechnicianHandoff } from "@/shared/turniq/multiTechnicianHandoffEngine";

function candidate(
  position: number,
  capableServiceIds: readonly string[],
  overrides: Partial<TurnIqCandidateInput> = {},
): TurnIqCandidateInput {
  const staffId = `handoff-tech-${String(position).padStart(2, "0")}`;
  return {
    staffId,
    displayName: `Handoff Tech ${position}`,
    stableStaffId: staffId,
    checkInSessionId: `handoff-shift-${position}`,
    checkedInAt: `2026-09-02T15:${String(position).padStart(2, "0")}:00.000Z`,
    queuePosition: position,
    checkedIn: true,
    active: true,
    busy: false,
    approvedBreak: false,
    temporaryHold: false,
    refusalPenaltyActive: false,
    manualSafetyHold: false,
    capabilityDataComplete: true,
    capableServiceIds,
    nextAppointmentStartsAt: null,
    serviceCreditSinceCheckInCents: (position - 1) * 500,
    fairnessBaselineCents: 6_000,
    ...overrides,
  };
}

function segment(
  segmentId: string,
  serviceId: string,
  startsAt: string,
  releasesAt: string,
  priceCents: number,
  resourceId: string | null = null,
): TurnIqHandoffSegmentInput {
  return {
    segmentId,
    startsAt,
    releasesAt,
    resourceId,
    requestedTechnician: null,
    serviceLines: [
      {
        lineId: `${segmentId}-line`,
        serviceId,
        serviceName: serviceId,
        catalogPriceCents: priceCents,
        permittedAddonCents: 0,
        durationMinutes: Math.round(
          (Date.parse(releasesAt) - Date.parse(startsAt)) / 60_000,
        ),
        bufferMinutes: 0,
        requiredResourceTypeIds: resourceId ? ["pedicure-chair"] : [],
      },
    ],
  };
}

function inputFixture(): TurnIqHandoffDecisionInput {
  const candidates = [
    candidate(1, ["manicure"]),
    candidate(2, ["pedicure"]),
    candidate(3, ["manicure", "pedicure"]),
  ];
  return {
    policy: structuredClone(salonATurnPolicyFixture),
    request: {
      requestId: "handoff-request-01",
      salonId: salonATurnPolicyFixture.salonId,
      bookingId: "handoff-booking-01",
      segments: [
        segment(
          "manicure-segment",
          "manicure",
          "2026-09-02T18:00:00.000Z",
          "2026-09-02T19:00:00.000Z",
          4_000,
          "shared-chair-01",
        ),
        segment(
          "pedicure-segment",
          "pedicure",
          "2026-09-02T18:00:00.000Z",
          "2026-09-02T19:00:00.000Z",
          6_000,
          "shared-chair-01",
        ),
      ],
    },
    snapshot: {
      snapshotVersion: "handoff-snapshot-v1",
      capturedAt: "2026-09-02T17:59:00.000Z",
      businessDate: "2026-09-02",
      candidates,
      staffAvailability: candidates.map((item) => ({
        staffId: item.staffId,
        availableAt: "2026-09-02T18:00:00.000Z",
        busyWindows: [],
      })),
      resources: [
        {
          resourceId: "shared-chair-01",
          resourceTypeId: "pedicure-chair",
          available: true,
          availableAt: "2026-09-02T18:00:00.000Z",
          sameCustomerParallelCapacity: 2,
          policyFingerprint: "resource-policy-v1",
        },
      ],
    },
  };
}

describe("TurnIQ deterministic multi-technician handoff", () => {
  it("assigns overlapping services to qualified technicians and credits each person's work", async () => {
    const decision = await decideTurnIqMultiTechnicianHandoff(inputFixture());

    expect(decision.reasonCodes).toEqual(
      expect.arrayContaining([
        "HANDOFF_COMPLETE_PLAN",
        "HANDOFF_MULTI_TECH",
        "HANDOFF_SHARED_RESOURCE_VERIFIED",
      ]),
    );
    expect(decision.assignments).toEqual([
      expect.objectContaining({
        segmentId: "manicure-segment",
        staffId: "handoff-tech-01",
        opportunityCreditCents: 4_000,
      }),
      expect.objectContaining({
        segmentId: "pedicure-segment",
        staffId: "handoff-tech-02",
        opportunityCreditCents: 6_000,
      }),
    ]);
    expect(decision.performers).toEqual([
      {
        staffId: "handoff-tech-01",
        segmentIds: ["manicure-segment"],
        opportunityCreditCents: 4_000,
        turnsToConsumeOnAttributedWorkCompletion: 1,
      },
      {
        staffId: "handoff-tech-02",
        segmentIds: ["pedicure-segment"],
        opportunityCreditCents: 6_000,
        turnsToConsumeOnAttributedWorkCompletion: 1,
      },
    ]);
  });

  it("uses one technician for sequential compatible segments and consumes only one customer turn", async () => {
    const input = inputFixture();
    input.request.segments = [
      segment(
        "manicure-segment",
        "manicure",
        "2026-09-02T18:00:00.000Z",
        "2026-09-02T18:45:00.000Z",
        4_000,
      ),
      segment(
        "pedicure-segment",
        "pedicure",
        "2026-09-02T18:45:00.000Z",
        "2026-09-02T19:45:00.000Z",
        6_000,
      ),
    ];
    input.snapshot.candidates = [candidate(3, ["manicure", "pedicure"], {
      serviceCreditSinceCheckInCents: 0,
    })];
    input.snapshot.staffAvailability = [
      {
        staffId: "handoff-tech-03",
        availableAt: "2026-09-02T18:00:00.000Z",
        busyWindows: [],
      },
    ];
    input.snapshot.resources = [];

    const decision = await decideTurnIqMultiTechnicianHandoff(input);

    expect(decision.reasonCodes).toContain("HANDOFF_SINGLE_TECH_CONTINUITY");
    expect(decision.assignments.map((item) => item.staffId)).toEqual([
      "handoff-tech-03",
      "handoff-tech-03",
    ]);
    expect(decision.performers).toEqual([
      {
        staffId: "handoff-tech-03",
        segmentIds: ["manicure-segment", "pedicure-segment"],
        opportunityCreditCents: 10_000,
        turnsToConsumeOnAttributedWorkCompletion: 1,
      },
    ]);
  });

  it("checks occupied windows per segment instead of treating a later gap as all-day busy", async () => {
    const input = inputFixture();
    input.request.segments = [
      segment(
        "first-segment",
        "manicure",
        "2026-09-02T18:00:00.000Z",
        "2026-09-02T18:30:00.000Z",
        4_000,
      ),
      segment(
        "later-segment",
        "manicure",
        "2026-09-02T19:00:00.000Z",
        "2026-09-02T19:30:00.000Z",
        4_000,
      ),
    ];
    input.snapshot.candidates = [candidate(1, ["manicure"]), candidate(2, ["manicure"])];
    input.snapshot.staffAvailability = [
      {
        staffId: "handoff-tech-01",
        availableAt: "2026-09-02T18:00:00.000Z",
        busyWindows: [
          {
            startsAt: "2026-09-02T18:45:00.000Z",
            releasesAt: "2026-09-02T19:15:00.000Z",
          },
        ],
      },
      {
        staffId: "handoff-tech-02",
        availableAt: "2026-09-02T18:00:00.000Z",
        busyWindows: [],
      },
    ];
    input.snapshot.resources = [];

    const decision = await decideTurnIqMultiTechnicianHandoff(input);

    expect(decision.assignments).toHaveLength(2);
    expect(decision.assignments).toContainEqual(
      expect.objectContaining({ segmentId: "later-segment", staffId: "handoff-tech-02" }),
    );
    expect(decision.internalTrace.candidateTraces).toContainEqual(
      expect.objectContaining({
        segmentId: "later-segment",
        staffId: "handoff-tech-01",
        eligible: false,
        reasonCodes: expect.arrayContaining(["CURRENTLY_BUSY"]),
      }),
    );
  });

  it("re-ranks later sequential work with already planned opportunity credit", async () => {
    const input = inputFixture();
    input.policy = { ...input.policy, fairnessBandCents: 0 };
    input.request.segments = [
      segment(
        "first-segment",
        "manicure",
        "2026-09-02T18:00:00.000Z",
        "2026-09-02T18:30:00.000Z",
        4_000,
      ),
      segment(
        "second-segment",
        "manicure",
        "2026-09-02T18:30:00.000Z",
        "2026-09-02T19:00:00.000Z",
        4_000,
      ),
    ];
    input.snapshot.candidates = [
      candidate(1, ["manicure"], {
        serviceCreditSinceCheckInCents: 0,
        fairnessBaselineCents: 6_000,
      }),
      candidate(2, ["manicure"], {
        serviceCreditSinceCheckInCents: 0,
        fairnessBaselineCents: 6_000,
      }),
    ];
    input.snapshot.staffAvailability = input.snapshot.candidates.map((item) => ({
      staffId: item.staffId,
      availableAt: "2026-09-02T18:00:00.000Z",
      busyWindows: [],
    }));
    input.snapshot.resources = [];

    const decision = await decideTurnIqMultiTechnicianHandoff(input);

    expect(decision.assignments.map((item) => item.staffId)).toEqual([
      "handoff-tech-01",
      "handoff-tech-02",
    ]);
  });

  it("fails closed when a shared chair cannot support both simultaneous services", async () => {
    const input = inputFixture();
    input.snapshot.resources = input.snapshot.resources.map((resource) => ({
      ...resource,
      sameCustomerParallelCapacity: 1,
    }));

    await expect(decideTurnIqMultiTechnicianHandoff(input)).rejects.toThrow(
      "turniq_handoff_shared_resource_capacity_exceeded",
    );
  });

  it("protects an upcoming appointment before fairness or queue order", async () => {
    const input = inputFixture();
    input.snapshot.candidates = input.snapshot.candidates.map((item) =>
      item.staffId === "handoff-tech-01"
        ? {
            ...item,
            nextAppointmentStartsAt: "2026-09-02T18:30:00.000Z",
          }
        : item,
    );

    const decision = await decideTurnIqMultiTechnicianHandoff(input);

    expect(
      decision.assignments.find((item) => item.segmentId === "manicure-segment")
        ?.staffId,
    ).toBe("handoff-tech-03");
    expect(
      decision.internalTrace.candidateTraces.find(
        (trace) =>
          trace.segmentId === "manicure-segment" &&
          trace.staffId === "handoff-tech-01",
      ),
    ).toMatchObject({
      eligible: false,
      reasonCodes: ["INSUFFICIENT_APPOINTMENT_GAP"],
    });
  });

  it("labels a requested-tech fallback and requires owner action", async () => {
    const input = inputFixture();
    input.request.segments = input.request.segments.map((item) =>
      item.segmentId === "manicure-segment"
        ? {
            ...item,
            requestedTechnician: {
              staffId: "handoff-tech-02",
              source: "customer_selected" as const,
              actorId: "synthetic-customer",
              recordedAt: "2026-09-02T17:58:00.000Z",
            },
          }
        : item,
    );

    const decision = await decideTurnIqMultiTechnicianHandoff(input);

    expect(decision.reasonCodes).toContain("HANDOFF_REQUEST_FALLBACK");
    expect(decision.ownerActionRequired).toBe(true);
    expect(
      decision.assignments.find((item) => item.segmentId === "manicure-segment"),
    ).toMatchObject({ requestedTechnicianSatisfied: false });
  });

  it("returns no partial plan when one segment has no qualified technician", async () => {
    const input = inputFixture();
    input.request.segments = [
      input.request.segments[0],
      segment(
        "special-segment",
        "special-skill",
        "2026-09-02T18:00:00.000Z",
        "2026-09-02T19:00:00.000Z",
        7_000,
        "shared-chair-01",
      ),
    ];

    const decision = await decideTurnIqMultiTechnicianHandoff(input);

    expect(decision.reasonCodes).toEqual(["HANDOFF_NO_COMPLETE_PLAN"]);
    expect(decision.assignments).toEqual([]);
    expect(decision.performers).toEqual([]);
    expect(decision.ownerActionRequired).toBe(true);
  });

  it("is deterministic across candidate and availability ordering", async () => {
    const left = inputFixture();
    const right = inputFixture();
    right.snapshot.candidates = [...right.snapshot.candidates].reverse();
    right.snapshot.staffAvailability = [
      ...right.snapshot.staffAvailability,
    ].reverse();

    const [leftDecision, rightDecision] = await Promise.all([
      decideTurnIqMultiTechnicianHandoff(left),
      decideTurnIqMultiTechnicianHandoff(right),
    ]);

    expect(rightDecision.fingerprint).toBe(leftDecision.fingerprint);
    expect(rightDecision.assignments).toEqual(leftDecision.assignments);
    expect(rightDecision.performers).toEqual(leftDecision.performers);
  });

  it("never exposes peer money in its privacy-safe explanation", async () => {
    const decision = await decideTurnIqMultiTechnicianHandoff(inputFixture());

    expect(decision.privacySafeExplanation).not.toMatch(
      /\$|credit cents|fairness band|peer|6000|6500/i,
    );
  });
});
