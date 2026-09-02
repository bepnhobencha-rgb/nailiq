import { describe, expect, it } from "vitest";

import type {
  TurnIqCandidateInput,
  TurnIqGroupDecisionInput,
  TurnIqGroupTaskInput,
  TurnIqGroupTimingPreference,
} from "@/shared/turniq/contracts";
import { salonAGroupInputFixture } from "@/shared/turniq/fixtures/salonA";
import { simulateTurnIqGroupTiming } from "@/shared/turniq/groupTimingSimulationEngine";

function task(
  taskId: string,
  durationMinutes: number,
  serviceId = "classic",
  requiredResourceTypeIds: readonly string[] = [],
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
        durationMinutes,
        bufferMinutes: 0,
        requiredResourceTypeIds,
      },
    ],
  };
}

function candidate(
  index: number,
  overrides: Partial<TurnIqCandidateInput> = {},
): TurnIqCandidateInput {
  const id = `timing-tech-${String(index).padStart(2, "0")}`;
  return {
    staffId: id,
    displayName: `Tech ${index}`,
    stableStaffId: id,
    checkInSessionId: `timing-shift-${index}`,
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
    capableServiceIds: ["classic", "deluxe"],
    nextAppointmentStartsAt: null,
    serviceCreditSinceCheckInCents: (index - 1) * 500,
    fairnessBaselineCents: 6_000,
    ...overrides,
  };
}

function input(
  tasks: readonly TurnIqGroupTaskInput[],
  candidates: readonly TurnIqCandidateInput[],
  availability: Readonly<Record<string, string>> = {},
  resources: TurnIqGroupDecisionInput["snapshot"]["resources"] = [],
): TurnIqGroupDecisionInput {
  const fixture = structuredClone(salonAGroupInputFixture);
  return {
    ...fixture,
    request: {
      ...fixture.request,
      requestId: "timing-request-001",
      bookingGroupId: "timing-group-001",
      requestedStartAt: "2026-09-02T18:00:00.000Z",
      tasks,
    },
    snapshot: {
      ...fixture.snapshot,
      snapshotVersion: "timing-snapshot-v1",
      candidates,
      staffAvailability: candidates.map((staff) => ({
        staffId: staff.staffId,
        availableAt:
          availability[staff.staffId] ?? "2026-09-02T18:00:00.000Z",
      })),
      resources,
    },
  };
}

async function simulate(
  decisionInput: TurnIqGroupDecisionInput,
  timing: TurnIqGroupTimingPreference,
) {
  return simulateTurnIqGroupTiming({ decisionInput, timing });
}

describe("TurnIQ deterministic group timing simulation", () => {
  it("uses a database-safe deterministic UUID while retaining the full fingerprint", async () => {
    const decisionInput = input(
      [task("guest-a", 60), task("guest-b", 45)],
      [candidate(1), candidate(2)],
    );
    const timing = {
      intent: "smart_wave" as const,
      latestStartAt: "2026-09-02T20:00:00.000Z",
      cadenceMinutes: 5 as const,
    };
    const first = await simulate(decisionInput, timing);
    const second = await simulate(decisionInput, timing);
    expect(first.simulationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.simulationId).toBe(second.simulationId);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("moves the whole party to one proven start for start-together", async () => {
    const staff = [candidate(1), candidate(2), candidate(3)];
    const result = await simulate(
      input(
        [task("guest-a", 60), task("guest-b", 45), task("guest-c", 30)],
        staff,
        { [staff[2].staffId]: "2026-09-02T18:15:00.000Z" },
      ),
      {
        intent: "start_together",
        latestStartAt: "2026-09-02T18:30:00.000Z",
        cadenceMinutes: 5,
      },
    );

    expect(result.reasonCodes).toContain("TIMING_START_TOGETHER");
    expect(result.liveStateChanged).toBe(false);
    expect(new Set(result.assignments.map((item) => item.startsAt))).toEqual(
      new Set(["2026-09-02T18:15:00.000Z"]),
    );
    expect(result.assignments).toHaveLength(3);
  });

  it("stagger-starts different durations so the party finishes together", async () => {
    const result = await simulate(
      input([task("long", 60), task("short", 30)], [candidate(1), candidate(2)]),
      {
        intent: "finish_together",
        targetFinishAt: "2026-09-02T19:30:00.000Z",
      },
    );

    expect(result.reasonCodes).toContain("TIMING_FINISH_TOGETHER");
    expect(new Set(result.assignments.map((item) => item.releasesAt))).toEqual(
      new Set(["2026-09-02T19:30:00.000Z"]),
    );
    expect(
      result.assignments.find((item) => item.taskId === "long")?.startsAt,
    ).toBe("2026-09-02T18:30:00.000Z");
    expect(
      result.assignments.find((item) => item.taskId === "short")?.startsAt,
    ).toBe("2026-09-02T19:00:00.000Z");
  });

  it("reuses released staff safely across smart waves", async () => {
    const result = await simulate(
      input(
        [task("guest-a", 70), task("guest-b", 70), task("guest-c", 70)],
        [candidate(1), candidate(2)],
      ),
      {
        intent: "smart_wave",
        latestStartAt: "2026-09-02T20:30:00.000Z",
        cadenceMinutes: 5,
      },
    );

    expect(result.reasonCodes).toContain("TIMING_SMART_WAVE");
    expect(result.assignments).toHaveLength(3);
    expect(result.objectiveScore?.waveCount).toBe(2);
    expect(result.objectiveScore?.maximumWaitMinutes).toBe(70);
    const starts = result.assignments.map((item) => item.startsAt).sort();
    expect(starts).toEqual([
      "2026-09-02T18:00:00.000Z",
      "2026-09-02T18:00:00.000Z",
      "2026-09-02T19:10:00.000Z",
    ]);
  });

  it("reuses the same chair only after both staff and chair are released", async () => {
    const result = await simulate(
      input(
        [task("guest-a", 60, "classic", ["chair"]), task("guest-b", 60, "classic", ["chair"])],
        [candidate(1)],
        {},
        [
          {
            resourceId: "chair-01",
            resourceTypeId: "chair",
            available: true,
            availableAt: "2026-09-02T18:00:00.000Z",
          },
        ],
      ),
      {
        intent: "smart_wave",
        latestStartAt: "2026-09-02T20:00:00.000Z",
        cadenceMinutes: 5,
      },
    );

    expect(result.assignments).toHaveLength(2);
    expect(result.assignments.map((item) => item.resourceIds)).toEqual([
      ["chair-01"],
      ["chair-01"],
    ]);
    expect(result.assignments.map((item) => item.startsAt).sort()).toEqual([
      "2026-09-02T18:00:00.000Z",
      "2026-09-02T19:00:00.000Z",
    ]);
  });

  it("builds a two-wave plan for twelve guests with seven technicians", async () => {
    const result = await simulate(
      input(
        Array.from({ length: 12 }, (_, index) =>
          task(`guest-${String(index + 1).padStart(2, "0")}`, 70),
        ),
        Array.from({ length: 7 }, (_, index) => candidate(index + 1)),
      ),
      {
        intent: "smart_wave",
        latestStartAt: "2026-09-02T20:30:00.000Z",
        cadenceMinutes: 5,
      },
    );

    expect(result.assignments).toHaveLength(12);
    expect(result.reasonCodes).toContain("TIMING_COMPLETE_PLAN");
    expect(result.objectiveScore).toMatchObject({
      waveCount: 2,
      maximumWaitMinutes: 70,
    });
    expect(
      result.assignments.filter((item) => item.startsAt === "2026-09-02T18:00:00.000Z"),
    ).toHaveLength(7);
    expect(
      result.assignments.filter((item) => item.startsAt === "2026-09-02T19:10:00.000Z"),
    ).toHaveLength(5);
  });

  it("carries projected opportunity credit into the next wave", async () => {
    const result = await simulate(
      input(
        [
          task("guest-a", 60, "classic", ["chair"]),
          task("guest-b", 60, "classic", ["chair"]),
          task("guest-c", 60, "classic", ["chair"]),
        ],
        [candidate(1), candidate(2), candidate(3)],
        {},
        [
          {
            resourceId: "chair-01",
            resourceTypeId: "chair",
            available: true,
            availableAt: "2026-09-02T18:00:00.000Z",
          },
          {
            resourceId: "chair-02",
            resourceTypeId: "chair",
            available: true,
            availableAt: "2026-09-02T18:00:00.000Z",
          },
        ],
      ),
      {
        intent: "smart_wave",
        latestStartAt: "2026-09-02T20:00:00.000Z",
        cadenceMinutes: 5,
      },
    );

    expect(
      result.assignments.find((item) => item.startsAt === "2026-09-02T19:00:00.000Z")
        ?.staffId,
    ).toBe("timing-tech-03");
  });

  it("keeps trusted requested-technician precedence ahead of a shorter wait", async () => {
    const requestedTask = task("guest-a", 30);
    requestedTask.requestedTechnician = {
      staffId: "timing-tech-02",
      source: "customer_selected",
      actorId: "customer-01",
      recordedAt: "2026-09-02T17:55:00.000Z",
    };
    const staff = [candidate(1), candidate(2, { busy: true })];
    const result = await simulate(
      input([requestedTask, task("guest-b", 30)], staff, {
        "timing-tech-02": "2026-09-02T18:15:00.000Z",
      }),
      {
        intent: "smart_wave",
        latestStartAt: "2026-09-02T19:00:00.000Z",
        cadenceMinutes: 5,
      },
    );

    expect(
      result.assignments.find((item) => item.taskId === "guest-a"),
    ).toMatchObject({
      staffId: "timing-tech-02",
      startsAt: "2026-09-02T18:15:00.000Z",
      requestedTechnicianSatisfied: true,
    });
    expect(result.ownerActionRequired).toBe(false);
  });

  it("fails closed when an appointment gap cannot safely fit the group", async () => {
    const result = await simulate(
      input(
        [task("guest-a", 60), task("guest-b", 60)],
        [
          candidate(1, {
            nextAppointmentStartsAt: "2026-09-02T18:30:00.000Z",
          }),
          candidate(2, {
            nextAppointmentStartsAt: "2026-09-02T18:30:00.000Z",
          }),
        ],
      ),
      {
        intent: "start_together",
        latestStartAt: "2026-09-02T18:15:00.000Z",
        cadenceMinutes: 5,
      },
    );

    expect(result.assignments).toEqual([]);
    expect(result.reasonCodes).toContain("TIMING_NO_COMPLETE_PLAN");
    expect(result.ownerActionRequired).toBe(true);
  });

  it("is deterministic across task and staff input permutations", async () => {
    const tasks = [task("guest-a", 45), task("guest-b", 45), task("guest-c", 45)];
    const staff = [candidate(1), candidate(2), candidate(3)];
    const timing = {
      intent: "smart_wave",
      latestStartAt: "2026-09-02T19:30:00.000Z",
      cadenceMinutes: 5,
    } as const;
    const first = await simulate(input(tasks, staff), timing);
    const second = await simulate(input([...tasks].reverse(), [...staff].reverse()), timing);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.assignments).toEqual(first.assignments);
    expect(second.objectiveScore).toEqual(first.objectiveScore);
  });
});
