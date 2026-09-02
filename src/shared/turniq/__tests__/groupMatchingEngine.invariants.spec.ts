import { describe, expect, it } from "vitest";

import type {
  TurnIqCandidateInput,
  TurnIqGroupDecisionInput,
} from "@/shared/turniq/contracts";
import {
  salonAGroupInputFixture,
  salonATurnPolicyFixture,
} from "@/shared/turniq/fixtures/salonA";
import { decideTurnIqGroup } from "@/shared/turniq/groupMatchingEngine";

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

function scenario(seed: number): TurnIqGroupDecisionInput {
  const random = generator(seed);
  const partySize = 2 + (seed % 6);
  const candidateCount = partySize + 2;
  const tasks = Array.from({ length: partySize }, (_, index) => ({
    taskId: `invariant-task-${String(index + 1).padStart(2, "0")}`,
    requestedTechnician: null,
    serviceLines: [
      {
        lineId: `invariant-line-${String(index + 1).padStart(2, "0")}`,
        serviceId: "classic",
        serviceName: "Classic",
        catalogPriceCents: 5_000,
        permittedAddonCents: 0,
        durationMinutes: 45,
        bufferMinutes: 10,
        requiredResourceTypeIds: [] as readonly string[],
      },
    ],
  }));
  const candidates: TurnIqCandidateInput[] = Array.from(
    { length: candidateCount },
    (_, index) => {
      const position = index + 1;
      const staffId = `invariant-tech-${String(position).padStart(2, "0")}`;
      return {
        staffId,
        displayName: `Tech ${position}`,
        stableStaffId: staffId,
        checkInSessionId: `invariant-shift-${position}`,
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
        capableServiceIds: ["classic"],
        nextAppointmentStartsAt: null,
        serviceCreditSinceCheckInCents: Math.floor(random() * 20) * 500,
        fairnessBaselineCents: 5_000 + Math.floor(random() * 5) * 500,
      };
    },
  );
  return {
    policy: salonATurnPolicyFixture,
    request: {
      requestId: `invariant-group-${seed}`,
      salonId: salonATurnPolicyFixture.salonId,
      bookingGroupId: null,
      requestedStartAt: "2026-09-02T18:00:00.000Z",
      tasks,
    },
    snapshot: {
      snapshotVersion: `invariant-snapshot-${seed}`,
      capturedAt: "2026-09-02T17:59:00.000Z",
      businessDate: "2026-09-02",
      candidates,
      staffAvailability: candidates.map((candidate) => ({
        staffId: candidate.staffId,
        availableAt: "2026-09-02T18:00:00.000Z",
      })),
      resources: [],
    },
  };
}

describe("TurnIQ group matching invariants", () => {
  it("preserves complete, unique and permutation-stable plans across seeded salons", async () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const input = scenario(seed);
      const random = generator(seed * 17);
      const permuted: TurnIqGroupDecisionInput = structuredClone(input);
      permuted.request.tasks = shuffle(permuted.request.tasks, random);
      permuted.snapshot.candidates = shuffle(
        permuted.snapshot.candidates,
        random,
      );
      permuted.snapshot.staffAvailability = shuffle(
        permuted.snapshot.staffAvailability,
        random,
      );

      const [decision, reordered] = await Promise.all([
        decideTurnIqGroup(input),
        decideTurnIqGroup(permuted),
      ]);

      expect(decision.assignments).toHaveLength(input.request.tasks.length);
      expect(new Set(decision.assignments.map((item) => item.taskId)).size).toBe(
        input.request.tasks.length,
      );
      expect(new Set(decision.assignments.map((item) => item.staffId)).size).toBe(
        input.request.tasks.length,
      );
      expect(
        decision.assignments.every(
          (item) => Date.parse(item.releasesAt) > Date.parse(item.startsAt),
        ),
      ).toBe(true);
      expect(reordered.fingerprint).toBe(decision.fingerprint);
      expect(reordered.assignments).toEqual(decision.assignments);
      expect(reordered.objectiveScore).toEqual(decision.objectiveScore);
    }
  });

  it("does not mutate the seeded Salon A request or snapshot", async () => {
    const input = structuredClone(salonAGroupInputFixture);
    const before = structuredClone(input);

    await decideTurnIqGroup(input);

    expect(input).toEqual(before);
  });
});
