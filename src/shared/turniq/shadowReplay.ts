import type {
  TurnIqDecisionInput,
  TurnIqDecisionRecord,
  TurnIqPolicyVersion,
} from "@/shared/turniq/contracts";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import {
  decideSingleCustomer,
  TurnIqContractError,
} from "@/shared/turniq/singleCustomerEngine";

export const TURNIQ_SHADOW_DIVERGENCE_REASONS = [
  "customer_rejected_recommendation",
  "requested_technician_honored",
  "operational_exception",
  "manager_override",
  "staff_override",
] as const;

export type TurnIqShadowDivergenceReason =
  (typeof TURNIQ_SHADOW_DIVERGENCE_REASONS)[number];

export type TurnIqActualAssignment = {
  assignedStaffId: string | null;
  customerAddedAt: string;
  assignedAt: string | null;
  ownerIntervened: boolean;
  divergenceReason: TurnIqShadowDivergenceReason | null;
};

export type TurnIqShadowComparisonOutcome =
  | "actual_assignment_pending"
  | "matched_recommendation"
  | "explained_divergence"
  | "unexplained_divergence"
  | "actual_assignee_ineligible"
  | "no_safe_recommendation";

export type TurnIqShadowComparison = {
  outcome: TurnIqShadowComparisonOutcome;
  recommendedStaffId: string | null;
  actualAssignedStaffId: string | null;
  divergenceReason: TurnIqShadowDivergenceReason | null;
  ownerIntervened: boolean;
  assignmentLatencySeconds: number | null;
  privacySafeSummary: string;
};

export type TurnIqShadowMetrics = {
  total: number;
  matched: number;
  pending: number;
  noSafeRecommendation: number;
  explainedDivergence: number;
  unexplainedDivergence: number;
  actualAssigneeIneligible: number;
  ownerInterventions: number;
  recommendationAcceptanceBasisPoints: number | null;
  averageAssignmentLatencySeconds: number | null;
  medianAssignmentLatencySeconds: number | null;
};

export type TurnIqReplayCaseInput = {
  caseId: string;
  decisionInput: TurnIqDecisionInput;
  actualAssignment: TurnIqActualAssignment;
};

export type TurnIqReplayCaseResult = {
  caseId: string;
  businessDate: string;
  currentDecisionFingerprint: string;
  proposedDecisionFingerprint: string;
  currentRecommendedStaffId: string | null;
  proposedRecommendedStaffId: string | null;
  recommendationChanged: boolean;
  currentComparison: TurnIqShadowComparison;
  proposedComparison: TurnIqShadowComparison;
};

export type TurnIqReplayResult = {
  runId: string;
  salonId: string;
  createdAt: string;
  currentPolicyId: string;
  currentPolicyVersion: number;
  proposedPolicyId: string;
  proposedPolicyVersion: number;
  readOnly: true;
  cases: readonly TurnIqReplayCaseResult[];
  currentMetrics: TurnIqShadowMetrics;
  proposedMetrics: TurnIqShadowMetrics;
  resultFingerprint: string;
};

function parseIso(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TurnIqContractError(code);
  return parsed;
}

function comparisonSummary(outcome: TurnIqShadowComparisonOutcome): string {
  switch (outcome) {
    case "actual_assignment_pending":
      return "Waiting for the salon's actual assignment.";
    case "matched_recommendation":
      return "The salon assignment matched the TurnIQ recommendation.";
    case "explained_divergence":
      return "The salon chose another technician and recorded an operational reason.";
    case "unexplained_divergence":
      return "The salon chose another technician without a recorded reason.";
    case "actual_assignee_ineligible":
      return "The assigned technician was not eligible in the captured TurnIQ snapshot.";
    case "no_safe_recommendation":
      return "TurnIQ had no safe recommendation for this captured snapshot.";
  }
}

export function compareTurnIqShadowDecision(
  decision: TurnIqDecisionRecord,
  actual: TurnIqActualAssignment,
): TurnIqShadowComparison {
  const addedAt = parseIso(actual.customerAddedAt, "turniq_invalid_customer_added_at");
  const assignedAt = actual.assignedAt === null
    ? null
    : parseIso(actual.assignedAt, "turniq_invalid_actual_assigned_at");
  if ((actual.assignedStaffId === null) !== (assignedAt === null)) {
    throw new TurnIqContractError("turniq_actual_assignment_incomplete");
  }
  if (assignedAt !== null && assignedAt < addedAt) {
    throw new TurnIqContractError("turniq_actual_assignment_before_customer_added");
  }

  let outcome: TurnIqShadowComparisonOutcome;
  if (actual.assignedStaffId === null) {
    outcome = "actual_assignment_pending";
  } else if (decision.recommendedStaffId === null) {
    outcome = "no_safe_recommendation";
  } else if (decision.recommendedStaffId === actual.assignedStaffId) {
    outcome = "matched_recommendation";
  } else {
    const actualTrace = decision.candidates.find(
      (candidate) => candidate.staffId === actual.assignedStaffId,
    );
    outcome = actualTrace?.eligible === false || actualTrace === undefined
      ? "actual_assignee_ineligible"
      : actual.divergenceReason === null
        ? "unexplained_divergence"
        : "explained_divergence";
  }

  return {
    outcome,
    recommendedStaffId: decision.recommendedStaffId,
    actualAssignedStaffId: actual.assignedStaffId,
    divergenceReason: actual.divergenceReason,
    ownerIntervened: actual.ownerIntervened,
    assignmentLatencySeconds:
      assignedAt === null ? null : Math.round((assignedAt - addedAt) / 1_000),
    privacySafeSummary: comparisonSummary(outcome),
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function summarizeTurnIqShadowMetrics(
  comparisons: readonly TurnIqShadowComparison[],
): TurnIqShadowMetrics {
  const count = (outcome: TurnIqShadowComparisonOutcome) =>
    comparisons.filter((comparison) => comparison.outcome === outcome).length;
  const latencies = comparisons
    .map((comparison) => comparison.assignmentLatencySeconds)
    .filter((value): value is number => value !== null);
  const matched = count("matched_recommendation");
  const recommendableAssigned = comparisons.filter(
    (comparison) =>
      comparison.actualAssignedStaffId !== null &&
      comparison.recommendedStaffId !== null,
  ).length;
  return {
    total: comparisons.length,
    matched,
    pending: count("actual_assignment_pending"),
    noSafeRecommendation: count("no_safe_recommendation"),
    explainedDivergence: count("explained_divergence"),
    unexplainedDivergence: count("unexplained_divergence"),
    actualAssigneeIneligible: count("actual_assignee_ineligible"),
    ownerInterventions: comparisons.filter((comparison) => comparison.ownerIntervened)
      .length,
    recommendationAcceptanceBasisPoints:
      recommendableAssigned === 0
        ? null
        : Math.round((matched * 10_000) / recommendableAssigned),
    averageAssignmentLatencySeconds:
      latencies.length === 0
        ? null
        : Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
    medianAssignmentLatencySeconds: median(latencies),
  };
}

function replayInput(
  source: TurnIqDecisionInput,
  policy: TurnIqPolicyVersion,
): TurnIqDecisionInput {
  if (source.request.salonId !== policy.salonId) {
    throw new TurnIqContractError("turniq_replay_cross_salon_policy");
  }
  const cloned = structuredClone(source);
  cloned.policy = {
    ...structuredClone(policy),
    // Replay explicitly asks "what if this policy governed that day?".
    effectiveBusinessDate: cloned.snapshot.businessDate,
  };
  return cloned;
}

/** Deterministic read-only comparison; no persistence or domain mutation. */
export async function runTurnIqReplay(input: {
  runId: string;
  salonId: string;
  createdAt: string;
  currentPolicy: TurnIqPolicyVersion;
  proposedPolicy: TurnIqPolicyVersion;
  cases: readonly TurnIqReplayCaseInput[];
}): Promise<TurnIqReplayResult> {
  parseIso(input.createdAt, "turniq_invalid_replay_created_at");
  if (
    input.currentPolicy.salonId !== input.salonId ||
    input.proposedPolicy.salonId !== input.salonId
  ) {
    throw new TurnIqContractError("turniq_replay_cross_salon_run");
  }
  const caseIds = new Set(input.cases.map((entry) => entry.caseId));
  if (caseIds.size !== input.cases.length) {
    throw new TurnIqContractError("turniq_replay_duplicate_case_id");
  }

  const cases: TurnIqReplayCaseResult[] = [];
  for (const entry of [...input.cases].sort((left, right) =>
    left.caseId === right.caseId ? 0 : left.caseId < right.caseId ? -1 : 1,
  )) {
    if (entry.decisionInput.request.salonId !== input.salonId) {
      throw new TurnIqContractError("turniq_replay_cross_salon_case");
    }
    const currentDecision = await decideSingleCustomer(
      replayInput(entry.decisionInput, input.currentPolicy),
    );
    const proposedDecision = await decideSingleCustomer(
      replayInput(entry.decisionInput, input.proposedPolicy),
    );
    cases.push({
      caseId: entry.caseId,
      businessDate: entry.decisionInput.snapshot.businessDate,
      currentDecisionFingerprint: currentDecision.fingerprint,
      proposedDecisionFingerprint: proposedDecision.fingerprint,
      currentRecommendedStaffId: currentDecision.recommendedStaffId,
      proposedRecommendedStaffId: proposedDecision.recommendedStaffId,
      recommendationChanged:
        currentDecision.recommendedStaffId !== proposedDecision.recommendedStaffId,
      currentComparison: compareTurnIqShadowDecision(
        currentDecision,
        entry.actualAssignment,
      ),
      proposedComparison: compareTurnIqShadowDecision(
        proposedDecision,
        entry.actualAssignment,
      ),
    });
  }

  const resultWithoutFingerprint = {
    runId: input.runId,
    salonId: input.salonId,
    createdAt: input.createdAt,
    currentPolicyId: input.currentPolicy.policyId,
    currentPolicyVersion: input.currentPolicy.version,
    proposedPolicyId: input.proposedPolicy.policyId,
    proposedPolicyVersion: input.proposedPolicy.version,
    readOnly: true as const,
    cases,
    currentMetrics: summarizeTurnIqShadowMetrics(
      cases.map((entry) => entry.currentComparison),
    ),
    proposedMetrics: summarizeTurnIqShadowMetrics(
      cases.map((entry) => entry.proposedComparison),
    ),
  };
  const resultFingerprint = await sha256TurnIqHex(
    canonicalTurnIqJson(resultWithoutFingerprint),
  );
  return { ...resultWithoutFingerprint, resultFingerprint };
}
