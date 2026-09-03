import type {
  TurnIqDecisionInput,
  TurnIqDecisionRecord,
} from "@/shared/turniq/contracts";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import {
  compareTurnIqShadowDecision,
  type TurnIqActualAssignment,
  type TurnIqShadowComparison,
} from "@/shared/turniq/shadowReplay";
import { decideSingleCustomer } from "@/shared/turniq/singleCustomerEngine";

export const TURNIQ_SHADOW_TRUTH_PIPELINE_VERSION = 1 as const;

export type TurnIqShadowDecisionRow = {
  salonId: string;
  policyVersionId: string;
  engineDecisionId: string;
  requestId: string;
  bookingId: string | null;
  businessDate: string;
  observedAt: string;
  snapshotFingerprint: string;
  decisionFingerprint: string;
  observationFingerprint: string;
  recommendedStaffId: string | null;
  privacySafeExplanation: string;
  decisionReasonCodes: readonly string[];
  eligibleCandidateCount: number;
  skippedCandidateCount: number;
  decisionInput: TurnIqDecisionInput;
  decisionOutput: TurnIqDecisionRecord;
};

export type TurnIqShadowComparisonRow = {
  salonId: string;
  shadowDecisionId: string;
  actualAssignedStaffId: string;
  actualAssignedAt: string;
  customerAddedAt: string;
  comparisonOutcome: Exclude<
    TurnIqShadowComparison["outcome"],
    "actual_assignment_pending"
  >;
  divergenceReason: TurnIqShadowComparison["divergenceReason"];
  ownerIntervened: boolean;
  assignmentLatencySeconds: number;
  privacySafeSummary: string;
  comparisonFingerprint: string;
};

export interface TurnIqShadowTruthRepository {
  insertOrGetDecision(row: TurnIqShadowDecisionRow): Promise<{
    id: string;
    inserted: boolean;
  }>;
  insertOrGetComparison(row: TurnIqShadowComparisonRow): Promise<{
    inserted: boolean;
  }>;
}

export type CaptureTurnIqShadowTruthResult = {
  decisionId: string;
  decisionInserted: boolean;
  comparisonInserted: boolean;
  comparisonOutcome: TurnIqShadowComparison["outcome"];
};

export async function turnIqShadowObservationFingerprint(input: {
  salonId: string;
  bookingId: string | null;
  observationKey: unknown;
}): Promise<string> {
  return sha256TurnIqHex(
    canonicalTurnIqJson({
      pipelineVersion: TURNIQ_SHADOW_TRUTH_PIPELINE_VERSION,
      salonId: input.salonId,
      bookingId: input.bookingId,
      observationKey: input.observationKey,
    }),
  );
}

export type TurnIqShadowAssignmentAuditEvent = {
  bookingId: string;
  actorRole: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export function resolveTurnIqShadowActualAssignment(input: {
  bookingId: string;
  bookingCreatedAt: string;
  assignedStaffId: string | null;
  events: readonly TurnIqShadowAssignmentAuditEvent[];
}): TurnIqActualAssignment {
  if (!input.assignedStaffId) {
    return {
      assignedStaffId: null,
      customerAddedAt: input.bookingCreatedAt,
      assignedAt: null,
      ownerIntervened: false,
      divergenceReason: null,
    };
  }

  const latest = input.events
    .filter(
      (event) =>
        event.bookingId === input.bookingId &&
        Number.isFinite(Date.parse(event.createdAt)) &&
        (event.payload.staffId === input.assignedStaffId ||
          event.payload.newStaffId === input.assignedStaffId),
    )
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  if (!latest) {
    return {
      assignedStaffId: input.assignedStaffId,
      customerAddedAt: input.bookingCreatedAt,
      assignedAt: input.bookingCreatedAt,
      ownerIntervened: false,
      divergenceReason: null,
    };
  }

  const isOverride = latest.eventType === "booking_edited";
  const manager =
    isOverride && (latest.actorRole === "owner" || latest.actorRole === "admin");
  return {
    assignedStaffId: input.assignedStaffId,
    customerAddedAt: input.bookingCreatedAt,
    assignedAt: latest.createdAt,
    ownerIntervened: manager,
    divergenceReason: isOverride
      ? manager
        ? "manager_override"
        : "staff_override"
      : null,
  };
}

/**
 * Persists only immutable, PII-free shadow evidence. This function never
 * writes booking, staff, resource, queue, turn, or provider state.
 */
export async function captureTurnIqShadowTruth(input: {
  decisionInput: TurnIqDecisionInput;
  actualAssignment: TurnIqActualAssignment;
  /** Stable, PII-free identity of the observed booking assignment state. */
  observationKey: unknown;
  repository: TurnIqShadowTruthRepository;
}): Promise<CaptureTurnIqShadowTruthResult> {
  const decision = await decideSingleCustomer(input.decisionInput);
  const observationFingerprint = await turnIqShadowObservationFingerprint({
    salonId: decision.salonId,
    bookingId: input.decisionInput.request.bookingId,
    observationKey: input.observationKey,
  });
  const eligibleCandidateCount = decision.candidates.filter(
    (candidate) => candidate.eligible,
  ).length;
  const storedDecision = await input.repository.insertOrGetDecision({
    salonId: decision.salonId,
    policyVersionId: decision.policyId,
    engineDecisionId: decision.decisionId,
    requestId: input.decisionInput.request.requestId,
    bookingId: input.decisionInput.request.bookingId,
    businessDate: input.decisionInput.snapshot.businessDate,
    observedAt: decision.decidedAt,
    snapshotFingerprint: decision.snapshotVersion,
    decisionFingerprint: decision.fingerprint,
    observationFingerprint,
    recommendedStaffId: decision.recommendedStaffId,
    privacySafeExplanation: decision.privacySafeExplanation,
    decisionReasonCodes: decision.decisionReasonCodes,
    eligibleCandidateCount,
    skippedCandidateCount: decision.candidates.length - eligibleCandidateCount,
    decisionInput: structuredClone(input.decisionInput),
    decisionOutput: structuredClone(decision),
  });

  const comparison = compareTurnIqShadowDecision(
    decision,
    input.actualAssignment,
  );
  if (
    comparison.outcome === "actual_assignment_pending" ||
    comparison.actualAssignedStaffId === null ||
    comparison.assignmentLatencySeconds === null ||
    input.actualAssignment.assignedAt === null
  ) {
    return {
      decisionId: storedDecision.id,
      decisionInserted: storedDecision.inserted,
      comparisonInserted: false,
      comparisonOutcome: comparison.outcome,
    };
  }

  const comparisonFingerprint = await sha256TurnIqHex(
    canonicalTurnIqJson({
      pipelineVersion: TURNIQ_SHADOW_TRUTH_PIPELINE_VERSION,
      salonId: decision.salonId,
      shadowDecisionId: storedDecision.id,
      actualAssignedStaffId: comparison.actualAssignedStaffId,
      actualAssignedAt: input.actualAssignment.assignedAt,
      outcome: comparison.outcome,
      divergenceReason: comparison.divergenceReason,
    }),
  );
  const storedComparison = await input.repository.insertOrGetComparison({
    salonId: decision.salonId,
    shadowDecisionId: storedDecision.id,
    actualAssignedStaffId: comparison.actualAssignedStaffId,
    actualAssignedAt: input.actualAssignment.assignedAt,
    customerAddedAt: input.actualAssignment.customerAddedAt,
    comparisonOutcome: comparison.outcome,
    divergenceReason: comparison.divergenceReason,
    ownerIntervened: comparison.ownerIntervened,
    assignmentLatencySeconds: comparison.assignmentLatencySeconds,
    privacySafeSummary: comparison.privacySafeSummary,
    comparisonFingerprint,
  });

  return {
    decisionId: storedDecision.id,
    decisionInserted: storedDecision.inserted,
    comparisonInserted: storedComparison.inserted,
    comparisonOutcome: comparison.outcome,
  };
}
