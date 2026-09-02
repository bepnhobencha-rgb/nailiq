import type {
  TurnIqReasonCode,
  TurnIqRequestTrustLabel,
  TurnIqRequestedTechSource,
} from "@/shared/turniq/contracts";
import { explainWhyNotMe } from "@/shared/turniq/explanations";

export type TurnIqShiftReadRow = {
  id: string;
  staffId: string;
  businessDate: string;
  state: "active" | "approved_break" | "temporary_hold" | "checked_out";
  queuePosition: number;
  turnsConsumed: number;
  fairnessBaselineCents: number;
  serviceCreditSinceCheckInCents: number;
};

export type TurnIqAssignmentReadRow = {
  id: string;
  policyVersionId: string;
  bookingId: string | null;
  serviceId: string | null;
  resourceId: string | null;
  recommendedStaffId: string | null;
  assignedStaffId: string | null;
  requestedStaffId: string | null;
  requestedTechSource: TurnIqRequestedTechSource | null;
  requestTrustLabel: TurnIqRequestTrustLabel | null;
  decisionTimestamp: string;
  privacySafeExplanation: string;
  eligibleCandidates: readonly TurnIqCandidateReadRow[];
  skippedCandidates: readonly TurnIqCandidateReadRow[];
  refusalCategory:
    | "customer_declined"
    | "illness_emergency"
    | "unapproved_refusal"
    | null;
  refusalReason: string | null;
  refusalOutcome:
    | "no_penalty"
    | "no_penalty_temporary_hold"
    | "moved_to_queue_end"
    | null;
  refusedAt: string | null;
  redoOriginalAssignmentId?: string | null;
  redoCategory?:
    | "quality_issue"
    | "customer_damage_or_change"
    | "warranty_or_goodwill"
    | "other"
    | null;
  redoNote?: string | null;
  redoConsumesTurn?: boolean | null;
  redoCreditsOpportunity?: boolean | null;
  redoClassifiedAt?: string | null;
  completedAt?: string | null;
  status:
    | "recommended"
    | "confirmed"
    | "in_progress"
    | "completed"
    | "cancelled"
    | "rejected";
};

export type TurnIqCandidateReadRow = {
  staffId: string;
  reasonCodes: readonly TurnIqReasonCode[];
  queuePosition: number;
  rank: number | null;
};

export type TurnIqFairnessReceiptReadRow = {
  id: string;
  policyVersionId: string;
  assignmentId: string;
  recommendedStaffId: string | null;
  assignedStaffId: string;
  serviceId: string | null;
  resourceId: string | null;
  requestedTechSource: TurnIqRequestedTechSource | null;
  requestTrustLabel: TurnIqRequestTrustLabel | null;
  privacySafeExplanation: string;
  skippedReasonCodes: readonly TurnIqReasonCode[];
  fairnessBandCents: number;
  decisionFingerprint: string;
  commandFingerprint: string;
  actorRole: string;
  assignmentOutcome: "confirmed_recommendation" | "override";
  overrideReason: string | null;
  createdAt: string;
};

export type TurnIqExceptionReadRow = {
  id: string;
  policyVersionId: string;
  assignmentId: string | null;
  disputeId: string | null;
  exceptionType: string;
  status: "open" | "acknowledged" | "resolved" | "dismissed";
  privacySafeSummary: string;
  recommendedAction: string;
  stateVersion: number;
  createdAt: string;
};

export type TurnIqDisputeReadRow = {
  id: string;
  policyVersionId: string;
  assignmentId: string;
  fairnessReceiptId: string | null;
  targetType: "fairness_receipt" | "skip_decision";
  raisedByStaffId: string;
  category:
    | "assignment"
    | "skip_reason"
    | "turn_credit"
    | "service_credit"
    | "override"
    | "other";
  privacySafeReason: string;
  status: "open" | "under_review" | "resolved" | "dismissed";
  resolutionReason: string | null;
  stateVersion: number;
  createdAt: string;
};

export type TurnIqSwapReadRow = {
  id: string;
  policyVersionId: string;
  assignmentId: string;
  fromStaffId: string;
  toStaffId: string;
  reason: string;
  status: "pending_consents" | "ready" | "applied" | "rejected";
  consentedStaffIds: readonly string[];
  requestedAt: string;
  appliedAt: string | null;
};

export type TurnIqCorrectionReadRow = {
  id: string;
  policyVersionId: string;
  assignmentId: string;
  fairnessReceiptId: string;
  sequence: number;
  category:
    | "wrong_technician"
    | "missed_handoff"
    | "administrative_error"
    | "other";
  reason: string;
  previousStaffId: string;
  actualStaffId: string;
  turnMoved: boolean;
  opportunityCreditMovedCents: number;
  correctedAt: string;
};

export type TurnIqStaffDirectoryEntry = {
  id: string;
  name: string;
};

export type TurnIqServiceDirectoryEntry = {
  id: string;
  name: string;
};

export type TurnIqStaffShiftState =
  | TurnIqShiftReadRow["state"]
  | "not_checked_in";

export type TurnIqPilotEvidenceView = {
  businessDate: string;
  targetsAreHypotheses: true;
  recommendations: number;
  completedCustomers: number;
  confirmedAssignments: number;
  recommendationAcceptanceBasisPoints: number | null;
  overrides: number;
  medianAssignmentSeconds: number | null;
  waitP50Minutes: number | null;
  waitP90Minutes: number | null;
  walkinsJoined: number;
  walkaways: number;
  walkawayRateBasisPoints: number | null;
  walkawayRateIsProxy: true;
  fairnessReceipts: number;
  normalTurnsWithoutOwnerBasisPoints: number | null;
  exceptions: number;
  unresolvedExceptions: number;
  disputes: number;
  unresolvedDisputes: number;
  unresolvedOfflineConflicts: number;
  duplicateCommandConflicts: number;
  ownerDecisionSecondsObserved: number;
  offlineLossEvidenceComplete: boolean;
  requestSourceCounts: Readonly<Record<string, number>>;
  opportunityDistribution: readonly {
    staffId: string;
    opportunityCreditCents: number;
    turns: number;
  }[];
  opportunitySpreadCents: number;
};

export type TurnIqLiveBoardView = {
  businessDate: string | null;
  activePolicyVersionId: string | null;
  ownerActionRequired: boolean;
  ownerFreedomMessage: string;
  openExceptionCount: number;
  pilotEvidence?: TurnIqPilotEvidenceView | null;
  nextRecommendation: {
    assignmentId: string;
    policyVersionId: string;
    bookingId: string | null;
    recommendedStaffId: string;
    recommendedStaffName: string;
    serviceName: string | null;
    explanation: string;
    requestedTechTrustLabel: TurnIqRequestTrustLabel | null;
    blockedByException?: boolean;
    redo: {
      originalAssignmentId: string;
      category: NonNullable<TurnIqAssignmentReadRow["redoCategory"]>;
      note: string;
      consumesTurn: boolean;
      creditsOpportunity: boolean;
    } | null;
    skipped: readonly {
      staffId: string;
      staffName: string;
      reasonCodes: readonly TurnIqReasonCode[];
    }[];
  } | null;
  redoCandidates: readonly {
    assignmentId: string;
    policyVersionId: string;
    serviceName: string | null;
    assignedStaffId: string;
    assignedStaffName: string;
    completedAt: string;
  }[];
  swaps: readonly {
    id: string;
    policyVersionId: string;
    assignmentId: string;
    fromStaffId: string;
    fromStaffName: string;
    toStaffId: string;
    toStaffName: string;
    reason: string;
    status: TurnIqSwapReadRow["status"];
    consentCount: number;
  }[];
  recentCorrections: readonly {
    id: string;
    assignmentId: string;
    previousStaffName: string;
    actualStaffName: string;
    reason: string;
    category: TurnIqCorrectionReadRow["category"];
    correctedAt: string;
  }[];
  staff: readonly {
    staffId: string;
    staffName: string;
    state: TurnIqStaffShiftState;
    queuePosition: number | null;
    turnsConsumed: number;
    isRecommendedNext: boolean;
  }[];
  assignments: readonly {
    assignmentId: string;
    policyVersionId: string;
    bookingId: string | null;
    status: TurnIqAssignmentReadRow["status"];
    serviceId?: string | null;
    serviceName: string | null;
    assignedStaffId: string | null;
    recommendedStaffName: string | null;
    assignedStaffName: string | null;
    explanation: string;
  }[];
};

export type TurnIqStaffView = {
  staffId: string;
  staffName: string;
  businessDate: string | null;
  activePolicyVersionId: string | null;
  shiftState: TurnIqStaffShiftState;
  queuePosition: number | null;
  turnsConsumed: number;
  ownOpportunityCreditCents: number;
  currentAssignment: {
    assignmentId: string;
    policyVersionId: string;
    status: TurnIqAssignmentReadRow["status"];
    serviceName: string | null;
    explanation: string;
  } | null;
  whyNotMe: readonly TurnIqWhyNotMeView[];
  recentRefusals: readonly {
    assignmentId: string;
    serviceName: string | null;
    category: NonNullable<TurnIqAssignmentReadRow["refusalCategory"]>;
    outcome: NonNullable<TurnIqAssignmentReadRow["refusalOutcome"]>;
    reason: string;
    refusedAt: string;
  }[];
  recentRedos: readonly {
    assignmentId: string;
    serviceName: string | null;
    category: NonNullable<TurnIqAssignmentReadRow["redoCategory"]>;
    note: string;
    consumesTurn: boolean;
    creditsOpportunity: boolean;
    classifiedAt: string;
  }[];
  pendingSwaps: readonly {
    id: string;
    policyVersionId: string;
    assignmentId: string;
    fromStaffName: string;
    toStaffName: string;
    reason: string;
    status: TurnIqSwapReadRow["status"];
    ownDecision: "accepted" | null;
  }[];
  recentCorrections: readonly {
    id: string;
    assignmentId: string;
    direction: "moved_from_me" | "moved_to_me";
    reason: string;
    category: TurnIqCorrectionReadRow["category"];
    turnMoved: boolean;
    correctedAt: string;
  }[];
  recentReceipts: readonly TurnIqStaffReceiptView[];
};

export type TurnIqWhyNotMeView = {
  assignmentId: string;
  policyVersionId: string;
  serviceName: string | null;
  reasonCodes: readonly TurnIqReasonCode[];
  explanation: string;
  decidedAt: string;
  dispute: {
    id: string;
    status: TurnIqDisputeReadRow["status"];
    category: TurnIqDisputeReadRow["category"];
    reason: string;
    resolutionReason: string | null;
  } | null;
};

export type TurnIqStaffReceiptView = {
  id: string;
  policyVersionId: string;
  assignmentId: string;
  outcome: TurnIqFairnessReceiptReadRow["assignmentOutcome"];
  explanation: string;
  requestedTechSource: TurnIqRequestedTechSource | null;
  requestTrustLabel: TurnIqRequestTrustLabel | null;
  skippedReasonCodes: readonly TurnIqReasonCode[];
  overrideReason: string | null;
  dispute: {
    id: string;
    status: TurnIqDisputeReadRow["status"];
    category: TurnIqDisputeReadRow["category"];
    reason: string;
    resolutionReason: string | null;
  } | null;
  createdAt: string;
};

export type TurnIqFairnessReceiptView = TurnIqStaffReceiptView & {
  recommendedStaffName: string | null;
  assignedStaffName: string;
  serviceName: string | null;
  resourceId: string | null;
  ownerDetail: {
    fairnessBandCents: number;
    opportunityCreditCents: number;
    actualServiceRevenueCents: number | null;
    actualTaxCents: number | null;
    actualTipCents: number | null;
    decisionFingerprint: string;
    commandFingerprint: string;
    actorRole: string;
  } | null;
  corrections: readonly {
    id: string;
    sequence: number;
    previousStaffName: string;
    actualStaffName: string;
    category: TurnIqCorrectionReadRow["category"];
    reason: string;
    turnMoved: boolean;
    correctedAt: string;
  }[];
};

export type TurnIqExceptionInboxView = {
  ownerActionRequired: boolean;
  message: string;
  exceptions: readonly (TurnIqExceptionReadRow & {
    dispute: TurnIqDisputeReadRow | null;
  })[];
};

function byId<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

function activeAssignment(status: TurnIqAssignmentReadRow["status"]): boolean {
  return status === "recommended" || status === "confirmed" || status === "in_progress";
}

export function projectTurnIqLiveBoard(input: {
  businessDate: string;
  activePolicyVersionId: string | null;
  shifts: readonly TurnIqShiftReadRow[];
  assignments: readonly TurnIqAssignmentReadRow[];
  redoCandidates?: readonly TurnIqAssignmentReadRow[];
  staff: readonly TurnIqStaffDirectoryEntry[];
  services: readonly TurnIqServiceDirectoryEntry[];
  openExceptionCount: number;
  blockedAssignmentIds?: readonly string[];
  swaps?: readonly TurnIqSwapReadRow[];
  corrections?: readonly TurnIqCorrectionReadRow[];
}): TurnIqLiveBoardView {
  const staff = byId(input.staff);
  const shiftsByStaff = new Map(
    input.shifts.map((shift) => [shift.staffId, shift] as const),
  );
  const services = byId(input.services);
  const active = input.assignments
    .filter((assignment) => activeAssignment(assignment.status))
    .sort((left, right) =>
      left.decisionTimestamp === right.decisionTimestamp
        ? left.id.localeCompare(right.id)
        : left.decisionTimestamp.localeCompare(right.decisionTimestamp),
    );
  const next = active.find(
    (assignment) =>
      assignment.status === "recommended" && assignment.recommendedStaffId !== null,
  ) ?? null;
  const recommendedStaffId = next?.recommendedStaffId ?? null;
  const ownerActionRequired = input.openExceptionCount > 0;

  return {
    businessDate: input.businessDate,
    activePolicyVersionId: input.activePolicyVersionId,
    ownerActionRequired,
    ownerFreedomMessage: ownerActionRequired
      ? "Owner review is needed for a real exception."
      : "No owner action needed. The team can continue normally.",
    openExceptionCount: input.openExceptionCount,
    nextRecommendation:
      next && recommendedStaffId
        ? {
            assignmentId: next.id,
            policyVersionId: next.policyVersionId,
            bookingId: next.bookingId,
            recommendedStaffId,
            recommendedStaffName: staff.get(recommendedStaffId)?.name ?? "Team member",
            serviceName: next.serviceId
              ? services.get(next.serviceId)?.name ?? null
              : null,
            explanation: next.privacySafeExplanation,
            requestedTechTrustLabel: next.requestTrustLabel,
            blockedByException: (input.blockedAssignmentIds ?? []).includes(next.id),
            redo:
              next.redoOriginalAssignmentId &&
              next.redoCategory &&
              next.redoNote &&
              typeof next.redoConsumesTurn === "boolean" &&
              typeof next.redoCreditsOpportunity === "boolean"
                ? {
                    originalAssignmentId: next.redoOriginalAssignmentId,
                    category: next.redoCategory,
                    note: next.redoNote,
                    consumesTurn: next.redoConsumesTurn,
                    creditsOpportunity: next.redoCreditsOpportunity,
                  }
                : null,
            skipped: next.skippedCandidates.map((candidate) => ({
              staffId: candidate.staffId,
              staffName: staff.get(candidate.staffId)?.name ?? "Team member",
              reasonCodes: candidate.reasonCodes,
            })),
          }
        : null,
    redoCandidates: (input.redoCandidates ?? [])
      .filter(
        (assignment) =>
          assignment.status === "completed" &&
          assignment.assignedStaffId !== null &&
          typeof assignment.completedAt === "string",
      )
      .map((assignment) => ({
        assignmentId: assignment.id,
        policyVersionId: assignment.policyVersionId,
        serviceName: assignment.serviceId
          ? services.get(assignment.serviceId)?.name ?? null
          : null,
        assignedStaffId: assignment.assignedStaffId!,
        assignedStaffName:
          staff.get(assignment.assignedStaffId!)?.name ?? "Team member",
        completedAt: assignment.completedAt!,
      })),
    swaps: (input.swaps ?? []).map((swap) => ({
      id: swap.id,
      policyVersionId: swap.policyVersionId,
      assignmentId: swap.assignmentId,
      fromStaffId: swap.fromStaffId,
      fromStaffName: staff.get(swap.fromStaffId)?.name ?? "Team member",
      toStaffId: swap.toStaffId,
      toStaffName: staff.get(swap.toStaffId)?.name ?? "Team member",
      reason: swap.reason,
      status: swap.status,
      consentCount: swap.consentedStaffIds.length,
    })),
    recentCorrections: (input.corrections ?? []).map((correction) => ({
      id: correction.id,
      assignmentId: correction.assignmentId,
      previousStaffName:
        staff.get(correction.previousStaffId)?.name ?? "Team member",
      actualStaffName:
        staff.get(correction.actualStaffId)?.name ?? "Team member",
      reason: correction.reason,
      category: correction.category,
      correctedAt: correction.correctedAt,
    })),
    staff: input.staff
      .map((entry) => ({ entry, shift: shiftsByStaff.get(entry.id) ?? null }))
      .sort((left, right) => {
        if (left.shift && right.shift) {
          return (
            left.shift.queuePosition - right.shift.queuePosition ||
            left.entry.id.localeCompare(right.entry.id)
          );
        }
        if (left.shift) return -1;
        if (right.shift) return 1;
        return left.entry.name.localeCompare(right.entry.name);
      })
      .map(({ entry, shift }) => ({
        staffId: entry.id,
        staffName: entry.name,
        state: shift?.state ?? "not_checked_in",
        queuePosition: shift?.queuePosition ?? null,
        turnsConsumed: shift?.turnsConsumed ?? 0,
        isRecommendedNext: entry.id === recommendedStaffId,
      })),
    assignments: active.map((assignment) => ({
      assignmentId: assignment.id,
      policyVersionId: assignment.policyVersionId,
      bookingId: assignment.bookingId,
      status: assignment.status,
      serviceId: assignment.serviceId,
      serviceName: assignment.serviceId
        ? services.get(assignment.serviceId)?.name ?? null
        : null,
      assignedStaffId: assignment.assignedStaffId,
      recommendedStaffName: assignment.recommendedStaffId
        ? staff.get(assignment.recommendedStaffId)?.name ?? null
        : null,
      assignedStaffName: assignment.assignedStaffId
        ? staff.get(assignment.assignedStaffId)?.name ?? null
        : null,
      explanation: assignment.privacySafeExplanation,
    })),
  };
}

export function projectTurnIqStaffView(input: {
  activePolicyVersionId: string | null;
  staff: TurnIqStaffDirectoryEntry;
  shift: TurnIqShiftReadRow | null;
  assignments: readonly TurnIqAssignmentReadRow[];
  receipts: readonly TurnIqFairnessReceiptReadRow[];
  disputes?: readonly TurnIqDisputeReadRow[];
  services: readonly TurnIqServiceDirectoryEntry[];
  swaps?: readonly TurnIqSwapReadRow[];
  corrections?: readonly TurnIqCorrectionReadRow[];
  staffDirectory?: readonly TurnIqStaffDirectoryEntry[];
}): TurnIqStaffView {
  const services = byId(input.services);
  const staffNames = byId(input.staffDirectory ?? [input.staff]);
  const current = input.assignments.find(
    (assignment) =>
      activeAssignment(assignment.status) &&
      (assignment.assignedStaffId === input.staff.id ||
        assignment.recommendedStaffId === input.staff.id),
  ) ?? null;
  const whyNotMe = input.assignments
    .flatMap((assignment) => {
      const trace = assignment.skippedCandidates.find(
        (candidate) => candidate.staffId === input.staff.id,
      );
      if (!trace) return [];
      const dispute = input.disputes?.find(
        (entry) =>
          entry.targetType === "skip_decision" &&
          entry.assignmentId === assignment.id &&
          entry.raisedByStaffId === input.staff.id,
      ) ?? null;
      return [{
        assignmentId: assignment.id,
        policyVersionId: assignment.policyVersionId,
        serviceName: assignment.serviceId
          ? services.get(assignment.serviceId)?.name ?? null
          : null,
        reasonCodes: trace.reasonCodes,
        explanation: explainWhyNotMe({
          eligible: false,
          rank: trace.rank,
          reasonCodes: trace.reasonCodes,
        }),
        decidedAt: assignment.decisionTimestamp,
        dispute: dispute
          ? {
              id: dispute.id,
              status: dispute.status,
              category: dispute.category,
              reason: dispute.privacySafeReason,
              resolutionReason: dispute.resolutionReason,
            }
          : null,
      }];
    })
    .sort((left, right) => right.decidedAt.localeCompare(left.decidedAt))
    .slice(0, 10);
  return {
    staffId: input.staff.id,
    staffName: input.staff.name,
    businessDate: input.shift?.businessDate ?? null,
    activePolicyVersionId: input.activePolicyVersionId,
    shiftState: input.shift?.state ?? "not_checked_in",
    queuePosition: input.shift?.queuePosition ?? null,
    turnsConsumed: input.shift?.turnsConsumed ?? 0,
    ownOpportunityCreditCents:
      (input.shift?.fairnessBaselineCents ?? 0) +
      (input.shift?.serviceCreditSinceCheckInCents ?? 0),
    currentAssignment: current
      ? {
          assignmentId: current.id,
          policyVersionId: current.policyVersionId,
          status: current.status,
          serviceName: current.serviceId
            ? services.get(current.serviceId)?.name ?? null
            : null,
          explanation: current.privacySafeExplanation,
        }
      : null,
    whyNotMe,
    recentRefusals: input.assignments
      .filter(
        (entry) =>
          entry.recommendedStaffId === input.staff.id &&
          entry.refusalCategory !== null &&
          entry.refusalOutcome !== null &&
          entry.refusalReason !== null &&
          entry.refusedAt !== null,
      )
      .sort((left, right) =>
        (right.refusedAt ?? "").localeCompare(left.refusedAt ?? ""),
      )
      .slice(0, 10)
      .map((entry) => ({
        assignmentId: entry.id,
        serviceName: entry.serviceId
          ? services.get(entry.serviceId)?.name ?? null
          : null,
        category: entry.refusalCategory!,
        outcome: entry.refusalOutcome!,
        reason: entry.refusalReason!,
        refusedAt: entry.refusedAt!,
      })),
    recentRedos: input.assignments
      .filter(
        (entry) =>
          (entry.assignedStaffId === input.staff.id ||
            entry.recommendedStaffId === input.staff.id) &&
          entry.redoCategory !== null &&
          entry.redoNote !== null &&
          typeof entry.redoConsumesTurn === "boolean" &&
          typeof entry.redoCreditsOpportunity === "boolean" &&
          typeof entry.redoClassifiedAt === "string",
      )
      .sort((left, right) =>
        (right.redoClassifiedAt ?? "").localeCompare(
          left.redoClassifiedAt ?? "",
        ),
      )
      .slice(0, 10)
      .map((entry) => ({
        assignmentId: entry.id,
        serviceName: entry.serviceId
          ? services.get(entry.serviceId)?.name ?? null
          : null,
        category: entry.redoCategory!,
        note: entry.redoNote!,
        consumesTurn: entry.redoConsumesTurn!,
        creditsOpportunity: entry.redoCreditsOpportunity!,
        classifiedAt: entry.redoClassifiedAt!,
      })),
    pendingSwaps: (input.swaps ?? [])
      .filter(
        (swap) =>
          swap.status !== "applied" &&
          swap.status !== "rejected" &&
          (swap.fromStaffId === input.staff.id || swap.toStaffId === input.staff.id),
      )
      .map((swap) => ({
        id: swap.id,
        policyVersionId: swap.policyVersionId,
        assignmentId: swap.assignmentId,
        fromStaffName: staffNames.get(swap.fromStaffId)?.name ?? "Team member",
        toStaffName: staffNames.get(swap.toStaffId)?.name ?? "Team member",
        reason: swap.reason,
        status: swap.status,
        ownDecision: swap.consentedStaffIds.includes(input.staff.id)
          ? "accepted"
          : null,
      })),
    recentCorrections: (input.corrections ?? [])
      .filter(
        (correction) =>
          correction.previousStaffId === input.staff.id ||
          correction.actualStaffId === input.staff.id,
      )
      .map((correction) => ({
        id: correction.id,
        assignmentId: correction.assignmentId,
        direction: correction.actualStaffId === input.staff.id
          ? "moved_to_me" as const
          : "moved_from_me" as const,
        reason: correction.reason,
        category: correction.category,
        turnMoved: correction.turnMoved,
        correctedAt: correction.correctedAt,
      })),
    recentReceipts: input.receipts
      .filter((receipt) => receipt.assignedStaffId === input.staff.id)
      .map((receipt) =>
        projectTurnIqStaffReceipt(
          receipt,
          input.disputes?.find(
            (dispute) =>
              dispute.targetType === "fairness_receipt" &&
              dispute.fairnessReceiptId === receipt.id &&
              dispute.raisedByStaffId === input.staff.id,
          ) ?? null,
        ),
      ),
  };
}

export function projectTurnIqStaffReceipt(
  receipt: TurnIqFairnessReceiptReadRow,
  dispute: TurnIqDisputeReadRow | null = null,
): TurnIqStaffReceiptView {
  return {
    id: receipt.id,
    policyVersionId: receipt.policyVersionId,
    assignmentId: receipt.assignmentId,
    outcome: receipt.assignmentOutcome,
    explanation: receipt.privacySafeExplanation,
    requestedTechSource: receipt.requestedTechSource,
    requestTrustLabel: receipt.requestTrustLabel,
    skippedReasonCodes: receipt.skippedReasonCodes,
    overrideReason: receipt.overrideReason,
    dispute: dispute
      ? {
          id: dispute.id,
          status: dispute.status,
          category: dispute.category,
          reason: dispute.privacySafeReason,
          resolutionReason: dispute.resolutionReason,
        }
      : null,
    createdAt: receipt.createdAt,
  };
}

export function projectTurnIqFairnessReceipt(input: {
  receipt: TurnIqFairnessReceiptReadRow;
  staff: readonly TurnIqStaffDirectoryEntry[];
  services: readonly TurnIqServiceDirectoryEntry[];
  includeOwnerDetail: boolean;
  ownerFinancialTruth?: {
    opportunityCreditCents: number;
    actualServiceRevenueCents: number | null;
    actualTaxCents: number | null;
    actualTipCents: number | null;
  };
  corrections?: readonly TurnIqCorrectionReadRow[];
}): TurnIqFairnessReceiptView {
  const staff = byId(input.staff);
  const services = byId(input.services);
  const base = projectTurnIqStaffReceipt(input.receipt);
  return {
    ...base,
    recommendedStaffName: input.receipt.recommendedStaffId
      ? staff.get(input.receipt.recommendedStaffId)?.name ?? null
      : null,
    assignedStaffName:
      staff.get(input.receipt.assignedStaffId)?.name ?? "Team member",
    serviceName: input.receipt.serviceId
      ? services.get(input.receipt.serviceId)?.name ?? null
      : null,
    resourceId: input.receipt.resourceId,
    ownerDetail: input.includeOwnerDetail
      ? {
          fairnessBandCents: input.receipt.fairnessBandCents,
          opportunityCreditCents:
            input.ownerFinancialTruth?.opportunityCreditCents ?? 0,
          actualServiceRevenueCents:
            input.ownerFinancialTruth?.actualServiceRevenueCents ?? null,
          actualTaxCents: input.ownerFinancialTruth?.actualTaxCents ?? null,
          actualTipCents: input.ownerFinancialTruth?.actualTipCents ?? null,
          decisionFingerprint: input.receipt.decisionFingerprint,
          commandFingerprint: input.receipt.commandFingerprint,
          actorRole: input.receipt.actorRole,
        }
      : null,
    corrections: (input.corrections ?? []).map((correction) => ({
      id: correction.id,
      sequence: correction.sequence,
      previousStaffName:
        staff.get(correction.previousStaffId)?.name ?? "Team member",
      actualStaffName:
        staff.get(correction.actualStaffId)?.name ?? "Team member",
      category: correction.category,
      reason: correction.reason,
      turnMoved: correction.turnMoved,
      correctedAt: correction.correctedAt,
    })),
  };
}

export function projectTurnIqExceptionInbox(
  exceptions: readonly TurnIqExceptionReadRow[],
  disputes: readonly TurnIqDisputeReadRow[] = [],
): TurnIqExceptionInboxView {
  const actionable = exceptions.filter(
    (entry) => entry.status === "open" || entry.status === "acknowledged",
  );
  return {
    ownerActionRequired: actionable.length > 0,
    message:
      actionable.length > 0
        ? `${actionable.length} exception${actionable.length === 1 ? "" : "s"} need review.`
        : "No owner action needed. The team can continue normally.",
    exceptions: actionable.map((entry) => ({
      ...entry,
      dispute: entry.disputeId
        ? disputes.find((dispute) => dispute.id === entry.disputeId) ?? null
        : null,
    })),
  };
}
