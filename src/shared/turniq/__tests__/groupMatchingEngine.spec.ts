import { describe, expect, it } from "vitest";

import type {
  TurnIqCandidateInput,
  TurnIqGroupDecisionInput,
  TurnIqGroupTaskInput,
} from "@/shared/turniq/contracts";
import { salonAGroupInputFixture } from "@/shared/turniq/fixtures/salonA";
import {
  decideTurnIqGroup,
  TURNIQ_GROUP_MAX_PARTY_SIZE,
} from "@/shared/turniq/groupMatchingEngine";

function cloneFixture(): TurnIqGroupDecisionInput {
  return structuredClone(salonAGroupInputFixture);
}

function task(
  taskId: string,
  serviceId: string,
  resourceTypeIds: readonly string[] = [],
): TurnIqGroupTaskInput {
  return {
    taskId,
    requestedTechnician: null,
    serviceLines: [
      {
        lineId: `${taskId}-line`,
        serviceId,
        serviceName: serviceId,
        catalogPriceCents: 5_000,
        permittedAddonCents: 0,
        durationMinutes: 60,
        bufferMinutes: 10,
        requiredResourceTypeIds: resourceTypeIds,
      },
    ],
  };
}

function candidate(
  index: number,
  capableServiceIds: readonly string[],
  overrides: Partial<TurnIqCandidateInput> = {},
): TurnIqCandidateInput {
  const id = `group-tech-${String(index).padStart(2, "0")}`;
  return {
    staffId: id,
    displayName: `Tech ${index}`,
    stableStaffId: id,
    checkInSessionId: `group-shift-${index}`,
    checkedInAt: `2026-09-02T15:${String(index).padStart(2, "0")}:00.000Z`,
    queuePosition: index,
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
    serviceCreditSinceCheckInCents: (index - 1) * 500,
    fairnessBaselineCents: 6_000,
    ...overrides,
  };
}

function focusedInput(
  tasks: readonly TurnIqGroupTaskInput[],
  candidates: readonly TurnIqCandidateInput[],
): TurnIqGroupDecisionInput {
  const input = cloneFixture();
  return {
    ...input,
    request: { ...input.request, tasks },
    snapshot: {
      ...input.snapshot,
      candidates,
      staffAvailability: candidates.map((item) => ({
        staffId: item.staffId,
        availableAt: "2026-09-02T18:00:00.000Z",
      })),
      resources: [],
    },
  };
}

describe("TurnIQ deterministic constrained group matcher", () => {
  it("produces a complete four-person plan with unique staff and resources", async () => {
    const decision = await decideTurnIqGroup(cloneFixture());

    expect(decision.reasonCodes).toContain("GROUP_COMPLETE_MATCH");
    expect(decision.assignments).toHaveLength(4);
    expect(new Set(decision.assignments.map((item) => item.staffId)).size).toBe(4);
    expect(
      new Set(decision.assignments.flatMap((item) => item.resourceIds)).size,
    ).toBe(4);
    expect(decision.assignments[0]).toMatchObject({
      taskId: "turniq-group-task-01",
      staffId: "turniq-staff-06",
      requestedTechnicianSatisfied: true,
    });
    expect(decision.ownerActionRequired).toBe(false);
  });

  it("avoids the greedy trap by reserving the only qualified technician", async () => {
    const input = focusedInput(
      [task("flexible", "classic"), task("constrained", "deluxe")],
      [
        candidate(1, ["classic", "deluxe"]),
        candidate(2, ["classic"]),
      ],
    );

    const decision = await decideTurnIqGroup(input);
    const byTask = new Map(
      decision.assignments.map((assignment) => [assignment.taskId, assignment]),
    );

    expect(byTask.get("constrained")?.staffId).toBe("group-tech-01");
    expect(byTask.get("flexible")?.staffId).toBe("group-tech-02");
  });

  it("honors a trusted requested technician when a complete plan remains feasible", async () => {
    const tasks = [task("guest-a", "classic"), task("guest-b", "classic")];
    tasks[0] = {
      ...tasks[0],
      requestedTechnician: {
        staffId: "group-tech-02",
        source: "in_person",
        actorId: "front-desk-01",
        recordedAt: "2026-09-02T17:59:00.000Z",
      },
    };
    const input = focusedInput(tasks, [
      candidate(1, ["classic"]),
      candidate(2, ["classic"]),
    ]);

    const decision = await decideTurnIqGroup(input);

    expect(
      decision.assignments.find((item) => item.taskId === "guest-a"),
    ).toMatchObject({
      staffId: "group-tech-02",
      requestedTechnicianSatisfied: true,
    });
    expect(decision.objectiveScore?.requestedFallbackCount).toBe(0);
  });

  it("keeps requested-tech precedence ahead of a shorter wait", async () => {
    const tasks = [task("guest-a", "classic"), task("guest-b", "classic")];
    tasks[0] = {
      ...tasks[0],
      requestedTechnician: {
        staffId: "group-tech-03",
        source: "ai_confirmed",
        actorId: "ai-call-01",
        recordedAt: "2026-09-02T17:59:00.000Z",
      },
    };
    const input = focusedInput(tasks, [
      candidate(1, ["classic"]),
      candidate(2, ["classic"]),
      candidate(3, ["classic"], { busy: true }),
    ]);
    input.snapshot.staffAvailability = input.snapshot.staffAvailability.map(
      (item) =>
        item.staffId === "group-tech-03"
          ? { ...item, availableAt: "2026-09-02T18:15:00.000Z" }
          : item,
    );

    const decision = await decideTurnIqGroup(input);

    expect(
      decision.assignments.find((item) => item.taskId === "guest-a"),
    ).toMatchObject({
      staffId: "group-tech-03",
      waitMinutes: 15,
      requestedTechnicianSatisfied: true,
    });
  });

  it("prioritizes appointment safety before wait and fairness cost", async () => {
    const input = focusedInput(
      [task("guest-a", "classic"), task("guest-b", "classic")],
      [
        candidate(1, ["classic"], {
          nextAppointmentStartsAt: "2026-09-02T19:15:00.000Z",
        }),
        candidate(2, ["classic"]),
        candidate(3, ["classic"], { busy: true }),
      ],
    );
    input.snapshot.staffAvailability = input.snapshot.staffAvailability.map(
      (item) =>
        item.staffId === "group-tech-03"
          ? { ...item, availableAt: "2026-09-02T18:10:00.000Z" }
          : item,
    );

    const decision = await decideTurnIqGroup(input);

    expect(decision.assignments.map((item) => item.staffId)).toEqual([
      "group-tech-02",
      "group-tech-03",
    ]);
  });

  it("falls back visibly when the requested technician is not qualified", async () => {
    const tasks = [task("guest-a", "deluxe"), task("guest-b", "classic")];
    tasks[0] = {
      ...tasks[0],
      requestedTechnician: {
        staffId: "group-tech-02",
        source: "customer_selected",
        actorId: "customer-01",
        recordedAt: "2026-09-02T17:59:00.000Z",
      },
    };
    const input = focusedInput(tasks, [
      candidate(1, ["classic", "deluxe"]),
      candidate(2, ["classic"]),
    ]);

    const decision = await decideTurnIqGroup(input);

    expect(decision.reasonCodes).toContain("GROUP_REQUEST_FALLBACK");
    expect(decision.ownerActionRequired).toBe(true);
    expect(
      decision.assignments.find((item) => item.taskId === "guest-a"),
    ).toMatchObject({
      staffId: "group-tech-01",
      requestedTechnicianSatisfied: false,
    });
  });

  it("excludes an assignment that cannot finish before the next appointment", async () => {
    const input = focusedInput(
      [task("guest-a", "classic"), task("guest-b", "classic")],
      [
        candidate(1, ["classic"], {
          nextAppointmentStartsAt: "2026-09-02T18:30:00.000Z",
        }),
        candidate(2, ["classic"]),
        candidate(3, ["classic"]),
      ],
    );

    const decision = await decideTurnIqGroup(input);

    expect(decision.assignments.map((item) => item.staffId)).not.toContain(
      "group-tech-01",
    );
  });

  it("fails closed when one resource cannot support two simultaneous guests", async () => {
    const input = focusedInput(
      [
        task("guest-a", "classic", ["chair"]),
        task("guest-b", "classic", ["chair"]),
      ],
      [candidate(1, ["classic"]), candidate(2, ["classic"])],
    );
    input.snapshot.resources = [
      {
        resourceId: "chair-01",
        resourceTypeId: "chair",
        available: true,
        availableAt: "2026-09-02T18:00:00.000Z",
      },
    ];

    const decision = await decideTurnIqGroup(input);

    expect(decision.assignments).toEqual([]);
    expect(decision.reasonCodes).toEqual(["GROUP_NO_COMPLETE_MATCH"]);
    expect(decision.ownerActionRequired).toBe(true);
  });

  it("is deterministic when tasks, candidates, availability and resources reorder", async () => {
    const first = cloneFixture();
    const second = cloneFixture();
    second.request.tasks = [...second.request.tasks].reverse();
    second.snapshot.candidates = [...second.snapshot.candidates].reverse();
    second.snapshot.staffAvailability = [
      ...second.snapshot.staffAvailability,
    ].reverse();
    second.snapshot.resources = [...second.snapshot.resources].reverse();

    const [left, right] = await Promise.all([
      decideTurnIqGroup(first),
      decideTurnIqGroup(second),
    ]);

    expect(right.fingerprint).toBe(left.fingerprint);
    expect(right.assignments).toEqual(left.assignments);
    expect(right.objectiveScore).toEqual(left.objectiveScore);
  });

  it("keeps a late technician from jumping ahead through a zero daily balance", async () => {
    const input = focusedInput(
      [task("guest-a", "classic"), task("guest-b", "classic")],
      [
        candidate(1, ["classic"]),
        candidate(2, ["classic"]),
        candidate(3, ["classic"], {
          checkedInAt: "2026-09-02T17:59:00.000Z",
          serviceCreditSinceCheckInCents: 0,
          fairnessBaselineCents: 12_000,
        }),
      ],
    );

    const decision = await decideTurnIqGroup(input);

    expect(decision.assignments.map((item) => item.staffId)).not.toContain(
      "group-tech-03",
    );
  });

  it("solves a twelve-person fully connected plan within the bounded exact search", async () => {
    const tasks = Array.from({ length: TURNIQ_GROUP_MAX_PARTY_SIZE }, (_, index) =>
      task(`guest-${String(index + 1).padStart(2, "0")}`, "classic"),
    );
    const candidates = Array.from(
      { length: TURNIQ_GROUP_MAX_PARTY_SIZE },
      (_, index) => candidate(index + 1, ["classic"]),
    );
    const input = focusedInput(tasks, candidates);

    const decision = await decideTurnIqGroup(input);

    expect(decision.assignments).toHaveLength(TURNIQ_GROUP_MAX_PARTY_SIZE);
    expect(new Set(decision.assignments.map((item) => item.staffId)).size).toBe(
      TURNIQ_GROUP_MAX_PARTY_SIZE,
    );
    expect(decision.reasonCodes).not.toContain("GROUP_SEARCH_LIMIT_REACHED");
    expect(decision.evaluatedSearchStates).toBeLessThan(250_000);
  });

  it("returns a padded privacy-safe ETA range without peer financial truth", async () => {
    const input = focusedInput(
      [task("guest-a", "classic"), task("guest-b", "classic")],
      [candidate(1, ["classic"]), candidate(2, ["classic"])],
    );
    input.snapshot.staffAvailability = input.snapshot.staffAvailability.map(
      (item, index) => ({
        ...item,
        availableAt: index === 0
          ? "2026-09-02T18:07:00.000Z"
          : "2026-09-02T18:12:00.000Z",
      }),
    );

    const decision = await decideTurnIqGroup(input);

    expect(decision.conservativeEta).toEqual({
      earliestStartMinutes: 5,
      allStartedByMinutes: 25,
      confidencePaddingMinutes: 11,
    });
    expect(decision.privacySafeExplanation).not.toMatch(
      /revenue|credit|tip|\$|6000/i,
    );
  });
});
