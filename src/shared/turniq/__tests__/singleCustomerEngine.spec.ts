import { describe, expect, it } from "vitest";

import type {
  TurnIqCandidateInput,
  TurnIqDecisionInput,
  TurnIqReasonCode,
} from "@/shared/turniq/contracts";
import { explainWhyNotMe, whyNotMeFromDecision } from "@/shared/turniq/explanations";
import { salonASingleCustomerInputFixture } from "@/shared/turniq/fixtures/salonA";
import { decideSingleCustomer } from "@/shared/turniq/singleCustomerEngine";

function inputFixture(): TurnIqDecisionInput {
  return structuredClone(salonASingleCustomerInputFixture);
}

function candidate(
  staffId: string,
  queuePosition: number,
  serviceCreditCents: number,
  overrides: Partial<TurnIqCandidateInput> = {},
): TurnIqCandidateInput {
  return {
    staffId,
    displayName: staffId,
    stableStaffId: staffId,
    checkInSessionId: `session-${staffId}`,
    checkedInAt: "2026-09-02T15:00:00.000Z",
    queuePosition,
    checkedIn: true,
    active: true,
    busy: false,
    approvedBreak: false,
    temporaryHold: false,
    refusalPenaltyActive: false,
    manualSafetyHold: false,
    capabilityDataComplete: true,
    capableServiceIds: ["deluxe-pedicure"],
    nextAppointmentStartsAt: null,
    serviceCreditSinceCheckInCents: serviceCreditCents,
    fairnessBaselineCents: 0,
    ...overrides,
  };
}

function withCandidates(
  candidates: TurnIqCandidateInput[],
  requestedTechnician: TurnIqDecisionInput["request"]["requestedTechnician"] = null,
): TurnIqDecisionInput {
  const input = inputFixture();
  input.snapshot.candidates = candidates;
  input.request.requestedTechnician = requestedTechnician;
  return input;
}

function traceReason(
  decision: Awaited<ReturnType<typeof decideSingleCustomer>>,
  staffId: string,
  code: TurnIqReasonCode,
): boolean {
  return (
    decision.candidates
      .find((entry) => entry.staffId === staffId)
      ?.reasonCodes.includes(code) ?? false
  );
}

describe("TurnIQ deterministic single-customer engine", () => {
  it("honors an eligible recorded customer request before fairness ranking", async () => {
    const decision = await decideSingleCustomer(inputFixture());
    expect(decision.recommendedStaffId).toBe("turniq-staff-06");
    expect(decision.decisionReasonCodes).toContain("EXPLICIT_CUSTOMER_REQUEST");
    expect(decision.internalTrace.requestTrustLabel).toBe(
      "customer_claim_recorded",
    );
    expect(traceReason(decision, "turniq-staff-01", "REQUESTED_TECH_PRECEDENCE")).toBe(
      true,
    );
    expect(decision.privacySafeExplanation).toContain(
      "recorded customer request",
    );
  });

  it("falls back safely when the requested technician is ineligible", async () => {
    const input = inputFixture();
    input.request.requestedTechnician = {
      staffId: "turniq-staff-02",
      source: "customer_selected",
      actorId: "turniq-public-session-01",
      recordedAt: "2026-09-02T17:58:00.000Z",
    };
    const decision = await decideSingleCustomer(input);
    expect(decision.recommendedStaffId).toBe("turniq-staff-01");
    expect(decision.decisionReasonCodes).toContain("REQUESTED_TECH_UNAVAILABLE");
    expect(traceReason(decision, "turniq-staff-02", "CURRENTLY_BUSY")).toBe(true);
    expect(traceReason(decision, "turniq-staff-02", "REQUESTED_TECH_UNAVAILABLE")).toBe(
      true,
    );
  });

  it("does not grant precedence to an unverified legacy request", async () => {
    const input = withCandidates(
      [candidate("staff-a", 1, 0), candidate("staff-b", 2, 5_000)],
      {
        staffId: "staff-b",
        source: "legacy_unknown",
        actorId: "turniq-legacy-import-01",
        recordedAt: "2026-09-02T17:58:00.000Z",
      },
    );
    const decision = await decideSingleCustomer(input);
    expect(decision.recommendedStaffId).toBe("staff-a");
    expect(decision.decisionReasonCodes).toContain(
      "UNVERIFIED_LEGACY_REQUEST_IGNORED",
    );
  });

  it("uses queue order when candidates are inside the fairness band", async () => {
    const input = withCandidates([
      candidate("staff-lower-credit", 2, 10_000),
      candidate("staff-earlier-queue", 1, 12_000),
    ]);
    const decision = await decideSingleCustomer(input);
    expect(decision.recommendedStaffId).toBe("staff-earlier-queue");
    expect(
      traceReason(
        decision,
        "staff-lower-credit",
        "WITHIN_FAIRNESS_BAND_LATER_QUEUE",
      ),
    ).toBe(true);
  });

  it("prefers lower opportunity credit immediately outside the fairness band", async () => {
    const input = withCandidates([
      candidate("staff-lower-credit", 2, 10_000),
      candidate("staff-earlier-queue", 1, 12_001),
    ]);
    const decision = await decideSingleCustomer(input);
    expect(decision.recommendedStaffId).toBe("staff-lower-credit");
    expect(
      traceReason(
        decision,
        "staff-earlier-queue",
        "HIGHER_OPPORTUNITY_CREDIT",
      ),
    ).toBe(true);
  });

  it("uses stable staff ID only after fairness tier and queue tie", async () => {
    const input = withCandidates([
      candidate("staff-b", 1, 10_000),
      candidate("staff-a", 1, 10_000),
    ]);
    const decision = await decideSingleCustomer(input);
    expect(decision.recommendedStaffId).toBe("staff-a");
    expect(traceReason(decision, "staff-b", "STABLE_STAFF_ID_TIE_BREAK")).toBe(
      true,
    );
  });

  it("keeps a late technician from jumping ahead with a zero service balance", async () => {
    const input = withCandidates([
      candidate("on-time", 1, 8_000),
      candidate("late", 2, 0, {
        checkedInAt: "2026-09-02T18:00:00.000Z",
        fairnessBaselineCents: 8_500,
      }),
    ]);
    const decision = await decideSingleCustomer(input);
    expect(decision.recommendedStaffId).toBe("on-time");
  });

  it("includes service buffer in appointment-gap safety", async () => {
    const exactlySafe = withCandidates([
      candidate("exactly-safe", 1, 0, {
        nextAppointmentStartsAt: "2026-09-02T19:10:00.000Z",
      }),
    ]);
    const unsafe = withCandidates([
      candidate("one-minute-short", 1, 0, {
        nextAppointmentStartsAt: "2026-09-02T19:09:00.000Z",
      }),
    ]);
    expect((await decideSingleCustomer(exactlySafe)).recommendedStaffId).toBe(
      "exactly-safe",
    );
    const unsafeDecision = await decideSingleCustomer(unsafe);
    expect(unsafeDecision.recommendedStaffId).toBeNull();
    expect(
      traceReason(
        unsafeDecision,
        "one-minute-short",
        "INSUFFICIENT_APPOINTMENT_GAP",
      ),
    ).toBe(true);
  });

  it.each([
    ["not-checked-in", { checkedIn: false }, "NOT_CHECKED_IN"],
    ["inactive", { active: false }, "STAFF_INACTIVE"],
    ["busy", { busy: true }, "CURRENTLY_BUSY"],
    ["break", { approvedBreak: true }, "APPROVED_BREAK"],
    ["temporary-hold", { temporaryHold: true }, "TEMPORARY_HOLD"],
    ["refusal", { refusalPenaltyActive: true }, "ACTIVE_REFUSAL_PENALTY"],
    ["safety-hold", { manualSafetyHold: true }, "MANUAL_SAFETY_HOLD"],
  ] as const)("filters %s deterministically", async (staffId, override, reason) => {
    const decision = await decideSingleCustomer(
      withCandidates([candidate(staffId, 1, 0, override)]),
    );
    expect(decision.recommendedStaffId).toBeNull();
    expect(traceReason(decision, staffId, reason)).toBe(true);
  });

  it("fails closed when capability data is incomplete", async () => {
    const input = withCandidates([
      candidate("unknown-capability", 1, 0, {
        capabilityDataComplete: false,
        capableServiceIds: [],
      }),
    ]);
    const decision = await decideSingleCustomer(input);
    expect(decision.recommendedStaffId).toBeNull();
    expect(
      traceReason(
        decision,
        "unknown-capability",
        "CAPABILITY_DATA_INCOMPLETE",
      ),
    ).toBe(true);
    expect(traceReason(decision, "unknown-capability", "SKILL_MISMATCH")).toBe(
      false,
    );
  });

  it("skips a skill mismatch without changing queue position", async () => {
    const input = withCandidates([
      candidate("wrong-skill", 1, 0, { capableServiceIds: [] }),
      candidate("qualified", 2, 0),
    ]);
    const decision = await decideSingleCustomer(input);
    expect(decision.recommendedStaffId).toBe("qualified");
    const skipped = decision.candidates.find(
      (entry) => entry.staffId === "wrong-skill",
    );
    expect(skipped?.queuePosition).toBe(1);
    expect(skipped?.reasonCodes).toContain("SKILL_MISMATCH");
  });

  it("returns no recommendation when a required resource is unavailable", async () => {
    const input = withCandidates([candidate("qualified", 1, 0)]);
    input.snapshot.resources = [];
    const decision = await decideSingleCustomer(input);
    expect(decision.recommendedStaffId).toBeNull();
    expect(decision.decisionReasonCodes).toEqual([
      "NO_ELIGIBLE_CANDIDATE",
      "RESOURCE_UNAVAILABLE",
    ]);
    expect(decision.privacySafeExplanation).toBe(
      "No safe recommendation: the required resource is unavailable.",
    );
  });

  it("fails closed for a future policy or mismatched salon business day", async () => {
    const futurePolicy = withCandidates([candidate("qualified", 1, 0)]);
    futurePolicy.policy.effectiveBusinessDate = "2026-09-03";
    const futureDecision = await decideSingleCustomer(futurePolicy);
    expect(futureDecision.recommendedStaffId).toBeNull();
    expect(futureDecision.decisionReasonCodes).toContain("STALE_POLICY_VERSION");

    const staleSnapshot = withCandidates([candidate("qualified", 1, 0)]);
    staleSnapshot.snapshot.businessDate = "2026-09-03";
    const staleDecision = await decideSingleCustomer(staleSnapshot);
    expect(staleDecision.recommendedStaffId).toBeNull();
    expect(staleDecision.decisionReasonCodes).toContain("STALE_SNAPSHOT");
  });

  it("produces the same SHA-256 decision identity for semantically identical order", async () => {
    const first = withCandidates([
      candidate("staff-b", 2, 1_000),
      candidate("staff-a", 1, 0),
    ]);
    const second = structuredClone(first);
    second.snapshot.candidates = [...second.snapshot.candidates].reverse();
    const firstDecision = await decideSingleCustomer(first);
    const secondDecision = await decideSingleCustomer(second);
    expect(firstDecision.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(secondDecision.fingerprint).toBe(firstDecision.fingerprint);
    expect(secondDecision.decisionId).toBe(firstDecision.decisionId);
  });

  it("does not mutate its input", async () => {
    const input = inputFixture();
    const before = structuredClone(input);
    await decideSingleCustomer(input);
    expect(input).toEqual(before);
  });

  it("returns privacy-safe deterministic why-not-me explanations", async () => {
    const decision = await decideSingleCustomer(
      withCandidates([
        candidate("earlier", 1, 0),
        candidate("later", 2, 1_000),
      ]),
    );
    expect(whyNotMeFromDecision(decision, "later")).toBe(
      "You are eligible, but another technician is earlier in the active queue within the fairness band.",
    );
    const later = decision.candidates.find((entry) => entry.staffId === "later");
    expect(later && explainWhyNotMe(later)).not.toMatch(/\$|1000|credit/i);
    expect(decision.privacySafeExplanation).not.toMatch(/\$|cents|1000/i);
  });

  it("rejects cross-salon input before producing a decision", async () => {
    const input = inputFixture();
    input.request.salonId = "another-salon";
    await expect(decideSingleCustomer(input)).rejects.toMatchObject({
      code: "turniq_cross_salon_request",
    });
  });

  it("rejects missing request provenance actor and an out-of-range fairness band", async () => {
    const missingActor = inputFixture();
    if (!missingActor.request.requestedTechnician) {
      throw new Error("fixture_requested_technician_missing");
    }
    missingActor.request.requestedTechnician.actorId = "";
    await expect(decideSingleCustomer(missingActor)).rejects.toMatchObject({
      code: "turniq_requested_staff_actor_required",
    });

    const excessiveBand = inputFixture();
    excessiveBand.policy.fairnessBandCents = 10_001;
    await expect(decideSingleCustomer(excessiveBand)).rejects.toMatchObject({
      code: "turniq_fairness_band_out_of_range",
    });
  });
});
