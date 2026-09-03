import { describe, expect, it } from "vitest";

import type { TurnIqDecisionInput } from "@/shared/turniq/contracts";
import { salonASingleCustomerInputFixture } from "@/shared/turniq/fixtures/salonA";
import {
  captureTurnIqShadowTruth,
  resolveTurnIqShadowActualAssignment,
  type TurnIqShadowComparisonRow,
  type TurnIqShadowDecisionRow,
  type TurnIqShadowTruthRepository,
} from "@/shared/turniq/shadowTruth";

function fixture(): TurnIqDecisionInput {
  const input = structuredClone(salonASingleCustomerInputFixture);
  input.request.bookingId = "booking-shadow-001";
  return input;
}

function memoryRepository() {
  const decisions = new Map<string, { id: string; row: TurnIqShadowDecisionRow }>();
  const comparisons = new Map<string, TurnIqShadowComparisonRow>();
  const repository: TurnIqShadowTruthRepository = {
    async insertOrGetDecision(row) {
      const existing = decisions.get(row.observationFingerprint);
      if (existing) return { id: existing.id, inserted: false };
      const id = `shadow-${decisions.size + 1}`;
      decisions.set(row.observationFingerprint, { id, row });
      return { id, inserted: true };
    },
    async insertOrGetComparison(row) {
      if (comparisons.has(row.shadowDecisionId)) return { inserted: false };
      comparisons.set(row.shadowDecisionId, row);
      return { inserted: true };
    },
  };
  return { repository, decisions, comparisons };
}

describe("TurnIQ shadow truth persistence", () => {
  it("uses the exact queue assignment audit time without calling it an override", () => {
    expect(
      resolveTurnIqShadowActualAssignment({
        bookingId: "booking-shadow-001",
        bookingCreatedAt: "2026-09-02T17:50:00.000Z",
        assignedStaffId: "turniq-staff-06",
        events: [{
          bookingId: "booking-shadow-001",
          actorRole: "receptionist",
          eventType: "queue_assigned",
          payload: { staffId: "turniq-staff-06" },
          createdAt: "2026-09-02T17:56:00.000Z",
        }],
      }),
    ).toEqual({
      assignedStaffId: "turniq-staff-06",
      customerAddedAt: "2026-09-02T17:50:00.000Z",
      assignedAt: "2026-09-02T17:56:00.000Z",
      ownerIntervened: false,
      divergenceReason: null,
    });
  });

  it("labels an owner staff change as a manager override with its audit time", () => {
    expect(
      resolveTurnIqShadowActualAssignment({
        bookingId: "booking-shadow-001",
        bookingCreatedAt: "2026-09-02T17:50:00.000Z",
        assignedStaffId: "turniq-staff-07",
        events: [{
          bookingId: "booking-shadow-001",
          actorRole: "owner",
          eventType: "booking_edited",
          payload: {
            previousStaffId: "turniq-staff-06",
            newStaffId: "turniq-staff-07",
          },
          createdAt: "2026-09-02T17:58:00.000Z",
        }],
      }),
    ).toMatchObject({
      assignedStaffId: "turniq-staff-07",
      assignedAt: "2026-09-02T17:58:00.000Z",
      ownerIntervened: true,
      divergenceReason: "manager_override",
    });
  });

  it("stores one immutable decision and matched actual-assignment comparison", async () => {
    const memory = memoryRepository();
    const decisionInput = fixture();
    const result = await captureTurnIqShadowTruth({
      decisionInput,
      actualAssignment: {
        assignedStaffId: "turniq-staff-06",
        customerAddedAt: "2026-09-02T17:55:00.000Z",
        assignedAt: "2026-09-02T17:56:00.000Z",
        ownerIntervened: false,
        divergenceReason: null,
      },
      observationKey: { bookingId: "booking-shadow-001", status: "confirmed" },
      repository: memory.repository,
    });

    expect(result).toMatchObject({
      decisionInserted: true,
      comparisonInserted: true,
      comparisonOutcome: "matched_recommendation",
    });
    const stored = [...memory.decisions.values()][0]?.row;
    expect(stored?.bookingId).toBe("booking-shadow-001");
    expect(stored?.recommendedStaffId).toBe("turniq-staff-06");
    expect(stored?.eligibleCandidateCount).toBeGreaterThan(0);
    expect(stored?.decisionInput).toEqual(decisionInput);
    expect(JSON.stringify(stored)).not.toContain("client_phone");
    expect([...memory.comparisons.values()][0]).toMatchObject({
      actualAssignedStaffId: "turniq-staff-06",
      assignmentLatencySeconds: 60,
      comparisonOutcome: "matched_recommendation",
    });
  });

  it("deduplicates the same booking state even when a later page load has a new clock", async () => {
    const memory = memoryRepository();
    const observationKey = {
      bookingId: "booking-shadow-001",
      status: "confirmed",
      assignedStaffId: "turniq-staff-06",
    };
    const assignment = {
      assignedStaffId: "turniq-staff-06",
      customerAddedAt: "2026-09-02T17:55:00.000Z",
      assignedAt: "2026-09-02T17:56:00.000Z",
      ownerIntervened: false,
      divergenceReason: null,
    } as const;
    const first = await captureTurnIqShadowTruth({
      decisionInput: fixture(),
      actualAssignment: assignment,
      observationKey,
      repository: memory.repository,
    });
    const laterInput = fixture();
    laterInput.snapshot.capturedAt = "2026-09-02T18:01:00.000Z";
    const second = await captureTurnIqShadowTruth({
      decisionInput: laterInput,
      actualAssignment: assignment,
      observationKey,
      repository: memory.repository,
    });

    expect(first.decisionInserted).toBe(true);
    expect(second.decisionInserted).toBe(false);
    expect(second.comparisonInserted).toBe(false);
    expect(memory.decisions.size).toBe(1);
    expect(memory.comparisons.size).toBe(1);
  });

  it("keeps an unassigned customer pending without fabricating a comparison", async () => {
    const memory = memoryRepository();
    const result = await captureTurnIqShadowTruth({
      decisionInput: fixture(),
      actualAssignment: {
        assignedStaffId: null,
        customerAddedAt: "2026-09-02T17:55:00.000Z",
        assignedAt: null,
        ownerIntervened: false,
        divergenceReason: null,
      },
      observationKey: { bookingId: "booking-shadow-001", status: "waiting" },
      repository: memory.repository,
    });

    expect(result.comparisonOutcome).toBe("actual_assignment_pending");
    expect(result.comparisonInserted).toBe(false);
    expect(memory.decisions.size).toBe(1);
    expect(memory.comparisons.size).toBe(0);
  });
});
