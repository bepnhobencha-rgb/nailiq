import { salonYmdOfUtc } from "@/shared/lib/salonTime";
import type {
  TurnIqCandidateInput,
  TurnIqCandidateTrace,
  TurnIqDecisionInput,
  TurnIqDecisionRecord,
  TurnIqReasonCode,
} from "@/shared/turniq/contracts";
import { assertTurnIqCents, requestedTechTrustLabel } from "@/shared/turniq/contracts";
import { explainSingleCustomerDecision } from "@/shared/turniq/explanations";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";

export const TURNIQ_SINGLE_ENGINE_VERSION = 1 as const;

type EvaluatedCandidate = {
  input: TurnIqCandidateInput;
  trace: TurnIqCandidateTrace;
};

export class TurnIqContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TurnIqContractError";
  }
}

function requiredString(value: string, code: string): void {
  if (value.trim() === "") throw new TurnIqContractError(code);
}

function parseIso(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TurnIqContractError(code);
  return parsed;
}

function compareStableText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function validateInput(input: TurnIqDecisionInput): void {
  const { policy, request, snapshot } = input;
  if (policy.salonId !== request.salonId) {
    throw new TurnIqContractError("turniq_cross_salon_request");
  }
  if (
    request.partySize !== 1 ||
    request.serviceLines.length === 0 ||
    request.serviceLines.length > 5
  ) {
    throw new TurnIqContractError("turniq_single_customer_request_required");
  }
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) {
    throw new TurnIqContractError("turniq_invalid_policy_version");
  }
  assertTurnIqCents(policy.fairnessBandCents, "fairnessBandCents");
  if (policy.fairnessBandCents > 10_000) {
    throw new TurnIqContractError("turniq_fairness_band_out_of_range");
  }
  requiredString(policy.policyId, "turniq_policy_id_required");
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: policy.timezone }).format(0);
  } catch {
    throw new TurnIqContractError("turniq_invalid_policy_timezone");
  }
  requiredString(snapshot.snapshotVersion, "turniq_snapshot_version_required");
  parseIso(snapshot.capturedAt, "turniq_invalid_snapshot_timestamp");
  parseIso(request.requestedStartAt, "turniq_invalid_requested_start");

  const serviceLineIds = new Set<string>();
  for (const line of request.serviceLines) {
    requiredString(line.lineId, "turniq_service_line_id_required");
    requiredString(line.serviceId, "turniq_service_id_required");
    requiredString(line.serviceName, "turniq_service_name_required");
    if (serviceLineIds.has(line.lineId)) {
      throw new TurnIqContractError("turniq_duplicate_service_line_id");
    }
    serviceLineIds.add(line.lineId);
    assertTurnIqCents(line.catalogPriceCents, "catalogPriceCents");
    assertTurnIqCents(line.permittedAddonCents, "permittedAddonCents");
    if (
      !Number.isSafeInteger(line.durationMinutes) ||
      line.durationMinutes < 1 ||
      line.durationMinutes > 1_440
    ) {
      throw new TurnIqContractError("turniq_invalid_service_duration");
    }
    if (
      !Number.isSafeInteger(line.bufferMinutes) ||
      line.bufferMinutes < 0 ||
      line.bufferMinutes > 720
    ) {
      throw new TurnIqContractError("turniq_invalid_service_buffer");
    }
  }

  if (request.requestedTechnician) {
    requiredString(
      request.requestedTechnician.staffId,
      "turniq_requested_staff_id_required",
    );
    requiredString(
      request.requestedTechnician.actorId,
      "turniq_requested_staff_actor_required",
    );
    parseIso(
      request.requestedTechnician.recordedAt,
      "turniq_invalid_requested_staff_timestamp",
    );
  }

  const staffIds = new Set<string>();
  const stableStaffIds = new Set<string>();
  for (const candidate of snapshot.candidates) {
    requiredString(candidate.staffId, "turniq_staff_id_required");
    requiredString(candidate.displayName, "turniq_staff_display_name_required");
    requiredString(candidate.stableStaffId, "turniq_stable_staff_id_required");
    if (staffIds.has(candidate.staffId)) {
      throw new TurnIqContractError("turniq_duplicate_staff_id");
    }
    if (stableStaffIds.has(candidate.stableStaffId)) {
      throw new TurnIqContractError("turniq_duplicate_stable_staff_id");
    }
    staffIds.add(candidate.staffId);
    stableStaffIds.add(candidate.stableStaffId);
    if (!Number.isSafeInteger(candidate.queuePosition) || candidate.queuePosition < 1) {
      throw new TurnIqContractError("turniq_invalid_queue_position");
    }
    assertTurnIqCents(
      candidate.serviceCreditSinceCheckInCents,
      "serviceCreditSinceCheckInCents",
    );
    assertTurnIqCents(candidate.fairnessBaselineCents, "fairnessBaselineCents");
    parseIso(candidate.checkedInAt, "turniq_invalid_check_in_timestamp");
    if (candidate.nextAppointmentStartsAt !== null) {
      parseIso(
        candidate.nextAppointmentStartsAt,
        "turniq_invalid_next_appointment_timestamp",
      );
    }
  }

  const resourceIds = new Set<string>();
  for (const resource of snapshot.resources) {
    requiredString(resource.resourceId, "turniq_resource_id_required");
    requiredString(resource.resourceTypeId, "turniq_resource_type_id_required");
    if (resourceIds.has(resource.resourceId)) {
      throw new TurnIqContractError("turniq_duplicate_resource_id");
    }
    resourceIds.add(resource.resourceId);
  }
}

function requiredResourcesAvailable(input: TurnIqDecisionInput): boolean {
  const requiredTypes = new Set(
    input.request.serviceLines.flatMap((line) => line.requiredResourceTypeIds),
  );
  for (const resourceTypeId of requiredTypes) {
    if (
      !input.snapshot.resources.some(
        (resource) =>
          resource.resourceTypeId === resourceTypeId && resource.available,
      )
    ) {
      return false;
    }
  }
  return true;
}

function globalSafetyReasons(input: TurnIqDecisionInput): TurnIqReasonCode[] {
  const reasons: TurnIqReasonCode[] = [];
  if (input.policy.effectiveBusinessDate > input.snapshot.businessDate) {
    reasons.push("STALE_POLICY_VERSION");
  }
  if (
    salonYmdOfUtc(input.request.requestedStartAt, input.policy.timezone) !==
      input.snapshot.businessDate ||
    salonYmdOfUtc(input.snapshot.capturedAt, input.policy.timezone) !==
      input.snapshot.businessDate
  ) {
    reasons.push("STALE_SNAPSHOT");
  }
  if (!requiredResourcesAvailable(input)) reasons.push("RESOURCE_UNAVAILABLE");
  return reasons;
}

function evaluateCandidate(
  input: TurnIqDecisionInput,
  candidate: TurnIqCandidateInput,
  globalReasons: readonly TurnIqReasonCode[],
): EvaluatedCandidate {
  const reasons: TurnIqReasonCode[] = [];
  if (!candidate.checkedIn) reasons.push("NOT_CHECKED_IN");
  if (!candidate.active) reasons.push("STAFF_INACTIVE");
  if (candidate.busy) reasons.push("CURRENTLY_BUSY");
  if (candidate.approvedBreak) reasons.push("APPROVED_BREAK");
  if (candidate.temporaryHold) reasons.push("TEMPORARY_HOLD");

  if (!candidate.capabilityDataComplete) {
    reasons.push("CAPABILITY_DATA_INCOMPLETE");
  } else {
    const capable = input.request.serviceLines.every((line) =>
      candidate.capableServiceIds.includes(line.serviceId),
    );
    if (!capable) reasons.push("SKILL_MISMATCH");
  }

  if (candidate.nextAppointmentStartsAt !== null) {
    const requestedStartMs = parseIso(
      input.request.requestedStartAt,
      "turniq_invalid_requested_start",
    );
    const nextAppointmentMs = parseIso(
      candidate.nextAppointmentStartsAt,
      "turniq_invalid_next_appointment_timestamp",
    );
    const occupiedMinutes = input.request.serviceLines.reduce(
      (sum, line) => sum + line.durationMinutes + line.bufferMinutes,
      0,
    );
    const proposedFinishMs = requestedStartMs + occupiedMinutes * 60_000;
    if (nextAppointmentMs < requestedStartMs) {
      reasons.push("STALE_SNAPSHOT");
    } else if (proposedFinishMs > nextAppointmentMs) {
      reasons.push("INSUFFICIENT_APPOINTMENT_GAP");
    }
  }

  if (candidate.refusalPenaltyActive) reasons.push("ACTIVE_REFUSAL_PENALTY");
  if (candidate.manualSafetyHold) reasons.push("MANUAL_SAFETY_HOLD");
  reasons.push(...globalReasons);

  const fairnessCreditCents =
    candidate.serviceCreditSinceCheckInCents + candidate.fairnessBaselineCents;
  if (!Number.isSafeInteger(fairnessCreditCents)) {
    throw new TurnIqContractError("turniq_fairness_credit_overflow");
  }
  const eligible = reasons.length === 0;
  return {
    input: candidate,
    trace: {
      staffId: candidate.staffId,
      displayName: candidate.displayName,
      stableStaffId: candidate.stableStaffId,
      eligible,
      reasonCodes: eligible ? ["ELIGIBLE"] : reasons,
      queuePosition: candidate.queuePosition,
      fairnessCreditCents,
      fairnessTier: null,
      rank: null,
    },
  };
}

function queueOrder(left: EvaluatedCandidate, right: EvaluatedCandidate): number {
  if (left.trace.queuePosition !== right.trace.queuePosition) {
    return left.trace.queuePosition - right.trace.queuePosition;
  }
  return compareStableText(left.trace.stableStaffId, right.trace.stableStaffId);
}

function normalizedFingerprintMaterial(input: TurnIqDecisionInput): unknown {
  return {
    engineVersion: TURNIQ_SINGLE_ENGINE_VERSION,
    policy: input.policy,
    request: {
      ...input.request,
      serviceLines: input.request.serviceLines.map((line) => ({
        ...line,
        requiredResourceTypeIds: [...line.requiredResourceTypeIds].sort(),
      })),
    },
    snapshot: {
      ...input.snapshot,
      candidates: [...input.snapshot.candidates]
        .sort((left, right) =>
          compareStableText(left.stableStaffId, right.stableStaffId),
        )
        .map((candidate) => ({
          ...candidate,
          capableServiceIds: [...candidate.capableServiceIds].sort(),
        })),
      resources: [...input.snapshot.resources].sort((left, right) =>
        compareStableText(left.resourceId, right.resourceId),
      ),
    },
  };
}

/**
 * Pure single-customer recommendation. The only asynchronous step is the
 * deterministic browser-compatible SHA-256 fingerprint.
 */
export async function decideSingleCustomer(
  input: TurnIqDecisionInput,
): Promise<TurnIqDecisionRecord> {
  validateInput(input);
  const globalReasons = globalSafetyReasons(input);
  const evaluated = input.snapshot.candidates.map((candidate) =>
    evaluateCandidate(input, candidate, globalReasons),
  );
  const eligible = evaluated.filter((candidate) => candidate.trace.eligible);

  const minimumCredit = eligible.length > 0
    ? Math.min(...eligible.map((candidate) => candidate.trace.fairnessCreditCents))
    : 0;
  const tierWidthCents = input.policy.fairnessBandCents + 1;
  for (const candidate of eligible) {
    candidate.trace.fairnessTier = Math.floor(
      (candidate.trace.fairnessCreditCents - minimumCredit) / tierWidthCents,
    );
  }

  const fairnessRanked = [...eligible].sort((left, right) => {
    const leftTier = left.trace.fairnessTier ?? 0;
    const rightTier = right.trace.fairnessTier ?? 0;
    if (leftTier !== rightTier) return leftTier - rightTier;
    return queueOrder(left, right);
  });

  const requested = input.request.requestedTechnician;
  const requestHasTrustedProvenance = requested?.source !== "legacy_unknown";
  const requestedCandidate = requested && requestHasTrustedProvenance
    ? evaluated.find((candidate) => candidate.trace.staffId === requested.staffId)
    : undefined;
  const selectedRequestedCandidate = requestedCandidate?.trace.eligible
    ? requestedCandidate
    : undefined;
  const orderedEligible = selectedRequestedCandidate
    ? [
        selectedRequestedCandidate,
        ...fairnessRanked.filter(
          (candidate) => candidate !== selectedRequestedCandidate,
        ),
      ]
    : fairnessRanked;

  orderedEligible.forEach((candidate, index) => {
    candidate.trace.rank = index + 1;
  });
  const selected = orderedEligible[0] ?? null;

  if (selectedRequestedCandidate) {
    selectedRequestedCandidate.trace.reasonCodes = [
      "ELIGIBLE",
      "EXPLICIT_CUSTOMER_REQUEST",
    ];
    for (const candidate of orderedEligible.slice(1)) {
      candidate.trace.reasonCodes = ["ELIGIBLE", "REQUESTED_TECH_PRECEDENCE"];
    }
  } else if (selected) {
    for (const candidate of orderedEligible.slice(1)) {
      const reason: TurnIqReasonCode =
        (candidate.trace.fairnessTier ?? 0) > (selected.trace.fairnessTier ?? 0)
          ? "HIGHER_OPPORTUNITY_CREDIT"
          : candidate.trace.queuePosition > selected.trace.queuePosition
            ? "WITHIN_FAIRNESS_BAND_LATER_QUEUE"
            : "STABLE_STAFF_ID_TIE_BREAK";
      candidate.trace.reasonCodes = ["ELIGIBLE", reason];
    }
  }

  if (requestedCandidate && !requestedCandidate.trace.eligible) {
    requestedCandidate.trace.reasonCodes = [
      ...requestedCandidate.trace.reasonCodes,
      "REQUESTED_TECH_UNAVAILABLE",
    ];
  }

  const decisionReasonCodes: TurnIqReasonCode[] = [];
  if (!selected) decisionReasonCodes.push("NO_ELIGIBLE_CANDIDATE");
  decisionReasonCodes.push(...globalReasons);
  if (selectedRequestedCandidate) {
    decisionReasonCodes.push("EXPLICIT_CUSTOMER_REQUEST");
  } else if (requested && requested.source === "legacy_unknown") {
    decisionReasonCodes.push("UNVERIFIED_LEGACY_REQUEST_IGNORED");
  } else if (requested) {
    decisionReasonCodes.push("REQUESTED_TECH_UNAVAILABLE");
  } else if (selected) {
    decisionReasonCodes.push("ELIGIBLE");
  }

  const fingerprint = await sha256TurnIqHex(
    canonicalTurnIqJson(normalizedFingerprintMaterial(input)),
  );
  const queueOrdered = [...evaluated].sort(queueOrder).map(({ trace }) => trace);
  const internalOrdered = [
    ...orderedEligible,
    ...evaluated
      .filter((candidate) => !candidate.trace.eligible)
      .sort(queueOrder),
  ].map(({ trace }) => trace);
  const requestTrustLabel = requested
    ? requestedTechTrustLabel(requested.source)
    : null;

  return {
    decisionId: `turniq-decision-${fingerprint.slice(0, 32)}`,
    salonId: input.request.salonId,
    recommendedStaffId: selected?.trace.staffId ?? null,
    policyId: input.policy.policyId,
    policyVersion: input.policy.version,
    snapshotVersion: input.snapshot.snapshotVersion,
    decidedAt: input.snapshot.capturedAt,
    fingerprint,
    decisionReasonCodes,
    candidates: queueOrdered,
    privacySafeExplanation: explainSingleCustomerDecision(
      selected?.trace ?? null,
      decisionReasonCodes,
    ),
    internalTrace: {
      orderedCandidates: internalOrdered,
      fairnessBandCents: input.policy.fairnessBandCents,
      requestTrustLabel,
    },
  };
}
