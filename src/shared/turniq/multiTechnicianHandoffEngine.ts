import { salonYmdOfUtc } from "@/shared/lib/salonTime";
import {
  assertTurnIqCents,
  type TurnIqCandidateInput,
  type TurnIqHandoffDecisionInput,
  type TurnIqHandoffDecisionRecord,
  type TurnIqHandoffCandidateTrace,
  type TurnIqHandoffObjectiveScore,
  type TurnIqHandoffPerformerCredit,
  type TurnIqHandoffReasonCode,
  type TurnIqHandoffSegmentAssignment,
  type TurnIqHandoffSegmentInput,
  type TurnIqId,
  type TurnIqReasonCode,
} from "@/shared/turniq/contracts";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import { TurnIqContractError } from "@/shared/turniq/singleCustomerEngine";

export const TURNIQ_HANDOFF_ENGINE_VERSION = 1 as const;
export const TURNIQ_HANDOFF_MAX_SEGMENTS = 5 as const;
export const TURNIQ_HANDOFF_MAX_SEARCH_STATES = 350_000 as const;

const MINUTE_MS = 60_000;
const APPOINTMENT_SAFETY_TARGET_MINUTES = 60;

type HandoffEdge = {
  segmentId: TurnIqId;
  staffId: TurnIqId;
  stableStaffId: TurnIqId;
  startsAtMs: number;
  releasesAtMs: number;
  resourceId: TurnIqId | null;
  opportunityCreditCents: number;
  requestedTechnicianSatisfied: boolean | null;
  requestedFallbackCost: number;
  appointmentSafetyCostMinutes: number;
  baseFairnessCreditCents: number;
  queuePosition: number;
  stableKey: string;
};

type SearchResult = {
  edges: readonly HandoffEdge[];
  score: TurnIqHandoffObjectiveScore;
};

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function parseIso(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TurnIqContractError(code);
  return parsed;
}

function requiredString(value: string, code: string): void {
  if (value.trim() === "") throw new TurnIqContractError(code);
}

function intervalsOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function compareObjective(
  left: TurnIqHandoffObjectiveScore,
  right: TurnIqHandoffObjectiveScore,
): number {
  for (const field of [
    "requestedFallbackCount",
    "appointmentSafetyCostMinutes",
    "fairnessTierCost",
    "queueCost",
  ] as const) {
    const difference = left[field] - right[field];
    if (difference !== 0) return difference;
  }
  return compareText(left.stableTieBreakKey, right.stableTieBreakKey);
}

function validateServiceLines(segment: TurnIqHandoffSegmentInput): void {
  if (segment.serviceLines.length < 1 || segment.serviceLines.length > 5) {
    throw new TurnIqContractError("turniq_handoff_service_lines_out_of_range");
  }
  const lineIds = new Set<string>();
  for (const line of segment.serviceLines) {
    requiredString(line.lineId, "turniq_service_line_id_required");
    requiredString(line.serviceId, "turniq_service_id_required");
    requiredString(line.serviceName, "turniq_service_name_required");
    if (lineIds.has(line.lineId)) {
      throw new TurnIqContractError("turniq_duplicate_service_line_id");
    }
    lineIds.add(line.lineId);
    assertTurnIqCents(line.catalogPriceCents, "catalogPriceCents");
    assertTurnIqCents(line.permittedAddonCents, "permittedAddonCents");
    if (
      !Number.isSafeInteger(line.durationMinutes) ||
      line.durationMinutes < 1 ||
      line.durationMinutes > 1_440 ||
      !Number.isSafeInteger(line.bufferMinutes) ||
      line.bufferMinutes < 0 ||
      line.bufferMinutes > 720
    ) {
      throw new TurnIqContractError("turniq_invalid_handoff_service_duration");
    }
    if (line.requiredResourceTypeIds.length > 1) {
      throw new TurnIqContractError("turniq_handoff_multi_resource_unsupported");
    }
  }
}

function validateResources(input: TurnIqHandoffDecisionInput): boolean {
  const resources = new Map(
    input.snapshot.resources.map((resource) => [resource.resourceId, resource]),
  );
  if (resources.size !== input.snapshot.resources.length) {
    throw new TurnIqContractError("turniq_duplicate_resource_id");
  }
  let sharedResourceVerified = false;

  for (const resource of input.snapshot.resources) {
    requiredString(resource.resourceId, "turniq_resource_id_required");
    requiredString(resource.resourceTypeId, "turniq_resource_type_id_required");
    requiredString(
      resource.policyFingerprint,
      "turniq_handoff_resource_policy_fingerprint_required",
    );
    parseIso(resource.availableAt, "turniq_invalid_resource_available_at");
    if (
      !Number.isSafeInteger(resource.sameCustomerParallelCapacity) ||
      resource.sameCustomerParallelCapacity < 1 ||
      resource.sameCustomerParallelCapacity > TURNIQ_HANDOFF_MAX_SEGMENTS
    ) {
      throw new TurnIqContractError("turniq_invalid_same_customer_capacity");
    }
  }

  for (const segment of input.request.segments) {
    const requiredTypes = [
      ...new Set(
        segment.serviceLines.flatMap((line) => line.requiredResourceTypeIds),
      ),
    ];
    if (requiredTypes.length === 0) {
      if (segment.resourceId !== null) {
        throw new TurnIqContractError("turniq_handoff_unexpected_resource");
      }
      continue;
    }
    if (segment.resourceId === null) {
      throw new TurnIqContractError("turniq_handoff_required_resource_missing");
    }
    const resource = resources.get(segment.resourceId);
    if (
      !resource ||
      !resource.available ||
      resource.resourceTypeId !== requiredTypes[0] ||
      parseIso(resource.availableAt, "turniq_invalid_resource_available_at") >
        parseIso(segment.startsAt, "turniq_invalid_handoff_segment_start")
    ) {
      throw new TurnIqContractError("turniq_handoff_resource_unavailable");
    }
  }

  for (const resource of input.snapshot.resources) {
    const segments = input.request.segments
      .filter((segment) => segment.resourceId === resource.resourceId)
      .map((segment) => ({
        segment,
        startsAtMs: parseIso(
          segment.startsAt,
          "turniq_invalid_handoff_segment_start",
        ),
        releasesAtMs: parseIso(
          segment.releasesAt,
          "turniq_invalid_handoff_segment_release",
        ),
      }));
    for (const point of segments.map((item) => item.startsAtMs)) {
      const concurrent = segments.filter(
        (item) => item.startsAtMs <= point && point < item.releasesAtMs,
      ).length;
      if (concurrent > resource.sameCustomerParallelCapacity) {
        throw new TurnIqContractError("turniq_handoff_shared_resource_capacity_exceeded");
      }
      if (concurrent > 1) sharedResourceVerified = true;
    }
  }
  return sharedResourceVerified;
}

export function validateTurnIqHandoffDecisionInput(
  input: TurnIqHandoffDecisionInput,
): { sharedResourceVerified: boolean } {
  const { policy, request, snapshot } = input;
  if (policy.salonId !== request.salonId) {
    throw new TurnIqContractError("turniq_cross_salon_request");
  }
  requiredString(policy.policyId, "turniq_policy_id_required");
  requiredString(request.requestId, "turniq_handoff_request_id_required");
  requiredString(request.bookingId, "turniq_handoff_booking_id_required");
  requiredString(snapshot.snapshotVersion, "turniq_snapshot_version_required");
  if (
    request.segments.length < 2 ||
    request.segments.length > TURNIQ_HANDOFF_MAX_SEGMENTS
  ) {
    throw new TurnIqContractError("turniq_handoff_segments_out_of_range");
  }
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) {
    throw new TurnIqContractError("turniq_invalid_policy_version");
  }
  assertTurnIqCents(policy.fairnessBandCents, "fairnessBandCents");
  if (policy.fairnessBandCents > 10_000) {
    throw new TurnIqContractError("turniq_fairness_band_out_of_range");
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: policy.timezone }).format(0);
  } catch {
    throw new TurnIqContractError("turniq_invalid_policy_timezone");
  }
  parseIso(snapshot.capturedAt, "turniq_invalid_snapshot_timestamp");
  if (
    salonYmdOfUtc(snapshot.capturedAt, policy.timezone) !== snapshot.businessDate ||
    policy.effectiveBusinessDate > snapshot.businessDate
  ) {
    throw new TurnIqContractError("turniq_stale_handoff_snapshot");
  }

  const segmentIds = new Set<string>();
  const allLineIds = new Set<string>();
  for (const segment of request.segments) {
    requiredString(segment.segmentId, "turniq_handoff_segment_id_required");
    if (segmentIds.has(segment.segmentId)) {
      throw new TurnIqContractError("turniq_duplicate_handoff_segment_id");
    }
    segmentIds.add(segment.segmentId);
    validateServiceLines(segment);
    for (const line of segment.serviceLines) {
      if (allLineIds.has(line.lineId)) {
        throw new TurnIqContractError("turniq_duplicate_service_line_id");
      }
      allLineIds.add(line.lineId);
    }
    const startsAtMs = parseIso(
      segment.startsAt,
      "turniq_invalid_handoff_segment_start",
    );
    const releasesAtMs = parseIso(
      segment.releasesAt,
      "turniq_invalid_handoff_segment_release",
    );
    if (
      startsAtMs >= releasesAtMs ||
      startsAtMs < Date.parse(snapshot.capturedAt) - MINUTE_MS ||
      salonYmdOfUtc(segment.startsAt, policy.timezone) !== snapshot.businessDate
    ) {
      throw new TurnIqContractError("turniq_invalid_handoff_segment_window");
    }
    if (segment.requestedTechnician) {
      requiredString(
        segment.requestedTechnician.staffId,
        "turniq_requested_staff_id_required",
      );
      requiredString(
        segment.requestedTechnician.actorId,
        "turniq_requested_staff_actor_required",
      );
      parseIso(
        segment.requestedTechnician.recordedAt,
        "turniq_invalid_requested_staff_timestamp",
      );
    }
  }

  const staffIds = new Set<string>();
  const stableStaffIds = new Set<string>();
  for (const candidate of snapshot.candidates) {
    requiredString(candidate.staffId, "turniq_staff_id_required");
    requiredString(candidate.stableStaffId, "turniq_stable_staff_id_required");
    requiredString(candidate.displayName, "turniq_staff_display_name_required");
    if (staffIds.has(candidate.staffId) || stableStaffIds.has(candidate.stableStaffId)) {
      throw new TurnIqContractError("turniq_duplicate_handoff_staff_id");
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
    if (candidate.nextAppointmentStartsAt) {
      parseIso(
        candidate.nextAppointmentStartsAt,
        "turniq_invalid_next_appointment_timestamp",
      );
    }
  }

  const availabilityIds = new Set<string>();
  for (const availability of snapshot.staffAvailability) {
    requiredString(availability.staffId, "turniq_staff_id_required");
    if (availabilityIds.has(availability.staffId)) {
      throw new TurnIqContractError("turniq_duplicate_staff_availability");
    }
    availabilityIds.add(availability.staffId);
    parseIso(availability.availableAt, "turniq_invalid_staff_available_at");
    for (const window of availability.busyWindows) {
      const startsAtMs = parseIso(
        window.startsAt,
        "turniq_invalid_staff_busy_window_start",
      );
      const releasesAtMs = parseIso(
        window.releasesAt,
        "turniq_invalid_staff_busy_window_release",
      );
      if (startsAtMs >= releasesAtMs) {
        throw new TurnIqContractError("turniq_invalid_staff_busy_window");
      }
    }
  }
  if (
    availabilityIds.size !== staffIds.size ||
    [...staffIds].some((staffId) => !availabilityIds.has(staffId))
  ) {
    throw new TurnIqContractError("turniq_staff_availability_incomplete");
  }

  return { sharedResourceVerified: validateResources(input) };
}

function evaluateCandidate(
  candidate: TurnIqCandidateInput,
  segment: TurnIqHandoffSegmentInput,
  availableAtMs: number,
  busyWindows: readonly { startsAtMs: number; releasesAtMs: number }[],
  capturedAtMs: number,
): { eligible: boolean; reasonCodes: readonly TurnIqReasonCode[] } {
  const reasonCodes: TurnIqReasonCode[] = [];
  if (!candidate.checkedIn) reasonCodes.push("NOT_CHECKED_IN");
  if (!candidate.active) reasonCodes.push("STAFF_INACTIVE");
  if (candidate.approvedBreak) reasonCodes.push("APPROVED_BREAK");
  if (candidate.temporaryHold) reasonCodes.push("TEMPORARY_HOLD");
  if (candidate.refusalPenaltyActive) {
    reasonCodes.push("ACTIVE_REFUSAL_PENALTY");
  }
  if (candidate.manualSafetyHold) reasonCodes.push("MANUAL_SAFETY_HOLD");
  if (!candidate.capabilityDataComplete) {
    reasonCodes.push("CAPABILITY_DATA_INCOMPLETE");
  } else if (
    !segment.serviceLines.every((line) =>
      candidate.capableServiceIds.includes(line.serviceId),
    )
  ) {
    reasonCodes.push("SKILL_MISMATCH");
  }
  const startsAtMs = parseIso(
    segment.startsAt,
    "turniq_invalid_handoff_segment_start",
  );
  const releasesAtMs = parseIso(
    segment.releasesAt,
    "turniq_invalid_handoff_segment_release",
  );
  if (
    availableAtMs > startsAtMs ||
    (candidate.busy && availableAtMs <= capturedAtMs) ||
    busyWindows.some((window) =>
      intervalsOverlap(
        startsAtMs,
        releasesAtMs,
        window.startsAtMs,
        window.releasesAtMs,
      ),
    )
  ) {
    reasonCodes.push("CURRENTLY_BUSY");
  }
  if (candidate.nextAppointmentStartsAt) {
    const nextAppointmentMs = parseIso(
      candidate.nextAppointmentStartsAt,
      "turniq_invalid_next_appointment_timestamp",
    );
    if (nextAppointmentMs < startsAtMs || releasesAtMs > nextAppointmentMs) {
      reasonCodes.push("INSUFFICIENT_APPOINTMENT_GAP");
    }
  }
  return {
    eligible: reasonCodes.length === 0,
    reasonCodes: reasonCodes.length === 0 ? ["ELIGIBLE"] : reasonCodes,
  };
}

function buildEdges(
  input: TurnIqHandoffDecisionInput,
): {
  edgesBySegment: ReadonlyMap<string, readonly HandoffEdge[]>;
  candidateTraces: readonly TurnIqHandoffCandidateTrace[];
} {
  const availability = new Map(
    input.snapshot.staffAvailability.map((item) => [
      item.staffId,
      {
        availableAtMs: parseIso(
          item.availableAt,
          "turniq_invalid_staff_available_at",
        ),
        busyWindows: item.busyWindows.map((window) => ({
          startsAtMs: parseIso(
            window.startsAt,
            "turniq_invalid_staff_busy_window_start",
          ),
          releasesAtMs: parseIso(
            window.releasesAt,
            "turniq_invalid_staff_busy_window_release",
          ),
        })),
      },
    ]),
  );
  const capturedAtMs = parseIso(
    input.snapshot.capturedAt,
    "turniq_invalid_snapshot_timestamp",
  );
  const result = new Map<string, readonly HandoffEdge[]>();
  const candidateTraces: TurnIqHandoffCandidateTrace[] = [];

  for (const segment of input.request.segments) {
    const startsAtMs = parseIso(
      segment.startsAt,
      "turniq_invalid_handoff_segment_start",
    );
    const releasesAtMs = parseIso(
      segment.releasesAt,
      "turniq_invalid_handoff_segment_release",
    );
    const opportunityCreditCents = segment.serviceLines.reduce(
      (total, line) => total + line.catalogPriceCents + line.permittedAddonCents,
      0,
    );
    if (!Number.isSafeInteger(opportunityCreditCents)) {
      throw new TurnIqContractError("turniq_handoff_credit_overflow");
    }
    const trustedRequestedStaffId =
      segment.requestedTechnician &&
      segment.requestedTechnician.source !== "legacy_unknown"
        ? segment.requestedTechnician.staffId
        : null;
    const edges: HandoffEdge[] = [];

    for (const candidate of input.snapshot.candidates) {
      const staffAvailability = availability.get(candidate.staffId);
      if (staffAvailability === undefined) continue;
      const evaluation = evaluateCandidate(
        candidate,
        segment,
        staffAvailability.availableAtMs,
        staffAvailability.busyWindows,
        capturedAtMs,
      );
      const baseFairnessCreditCents =
        candidate.serviceCreditSinceCheckInCents + candidate.fairnessBaselineCents;
      if (!Number.isSafeInteger(baseFairnessCreditCents)) {
        throw new TurnIqContractError("turniq_fairness_credit_overflow");
      }
      candidateTraces.push({
        segmentId: segment.segmentId,
        staffId: candidate.staffId,
        eligible: evaluation.eligible,
        reasonCodes: evaluation.reasonCodes,
        fairnessCreditCents: baseFairnessCreditCents,
      });
      if (!evaluation.eligible) continue;

      let appointmentSafetyCostMinutes = 0;
      if (candidate.nextAppointmentStartsAt) {
        const nextAppointmentMs = parseIso(
          candidate.nextAppointmentStartsAt,
          "turniq_invalid_next_appointment_timestamp",
        );
        appointmentSafetyCostMinutes = Math.max(
          0,
          APPOINTMENT_SAFETY_TARGET_MINUTES -
            Math.floor((nextAppointmentMs - releasesAtMs) / MINUTE_MS),
        );
      }
      const nextBusyWindow = staffAvailability.busyWindows
        .filter((window) => window.startsAtMs >= releasesAtMs)
        .sort((left, right) => left.startsAtMs - right.startsAtMs)[0];
      if (nextBusyWindow) {
        appointmentSafetyCostMinutes = Math.max(
          appointmentSafetyCostMinutes,
          APPOINTMENT_SAFETY_TARGET_MINUTES -
            Math.floor((nextBusyWindow.startsAtMs - releasesAtMs) / MINUTE_MS),
        );
      }
      const requestedTechnicianSatisfied = trustedRequestedStaffId === null
        ? null
        : candidate.staffId === trustedRequestedStaffId;
      edges.push({
        segmentId: segment.segmentId,
        staffId: candidate.staffId,
        stableStaffId: candidate.stableStaffId,
        startsAtMs,
        releasesAtMs,
        resourceId: segment.resourceId,
        opportunityCreditCents,
        requestedTechnicianSatisfied,
        requestedFallbackCost: requestedTechnicianSatisfied === false ? 1 : 0,
        appointmentSafetyCostMinutes,
        baseFairnessCreditCents,
        queuePosition: candidate.queuePosition,
        stableKey: [
          segment.segmentId,
          candidate.stableStaffId,
          new Date(startsAtMs).toISOString(),
        ].join(":"),
      });
    }
    edges.sort((left, right) => compareText(left.stableKey, right.stableKey));
    result.set(segment.segmentId, edges);
  }
  return {
    edgesBySegment: result,
    candidateTraces: candidateTraces.sort((left, right) =>
      compareText(left.segmentId, right.segmentId) ||
      compareText(left.staffId, right.staffId),
    ),
  };
}

function searchPlan(
  input: TurnIqHandoffDecisionInput,
  edgesBySegment: ReadonlyMap<string, readonly HandoffEdge[]>,
): { result: SearchResult | null; evaluatedStates: number; limitReached: boolean } {
  const segmentOrder = [...input.request.segments].sort((left, right) => {
    const edgeDifference =
      (edgesBySegment.get(left.segmentId)?.length ?? 0) -
      (edgesBySegment.get(right.segmentId)?.length ?? 0);
    if (edgeDifference !== 0) return edgeDifference;
    const timeDifference = Date.parse(left.startsAt) - Date.parse(right.startsAt);
    return timeDifference !== 0
      ? timeDifference
      : compareText(left.segmentId, right.segmentId);
  });
  let best: SearchResult | null = null;
  let evaluatedStates = 0;
  let limitReached = false;

  const visit = (index: number, selected: HandoffEdge[]): void => {
    evaluatedStates += 1;
    if (evaluatedStates > TURNIQ_HANDOFF_MAX_SEARCH_STATES) {
      limitReached = true;
      return;
    }
    if (index === segmentOrder.length) {
      const plannedCredit = new Map<string, number>();
      let requestedFallbackCount = 0;
      let appointmentSafetyCostMinutes = 0;
      let fairnessTierCost = 0;
      let queueCost = 0;
      for (const edge of [...selected].sort((left, right) =>
        left.startsAtMs - right.startsAtMs || compareText(left.segmentId, right.segmentId),
      )) {
        requestedFallbackCount += edge.requestedFallbackCost;
        appointmentSafetyCostMinutes += edge.appointmentSafetyCostMinutes;
        const projectedCredit =
          edge.baseFairnessCreditCents + (plannedCredit.get(edge.staffId) ?? 0);
        const eligibleEdges = edgesBySegment.get(edge.segmentId) ?? [];
        const minimumProjectedCredit = Math.min(
          ...eligibleEdges.map(
            (candidateEdge) =>
              candidateEdge.baseFairnessCreditCents +
              (plannedCredit.get(candidateEdge.staffId) ?? 0),
          ),
        );
        fairnessTierCost += Math.floor(
          (projectedCredit - minimumProjectedCredit) /
            (input.policy.fairnessBandCents + 1),
        );
        queueCost += edge.queuePosition;
        plannedCredit.set(
          edge.staffId,
          (plannedCredit.get(edge.staffId) ?? 0) + edge.opportunityCreditCents,
        );
      }
      const score: TurnIqHandoffObjectiveScore = {
        requestedFallbackCount,
        appointmentSafetyCostMinutes,
        fairnessTierCost,
        queueCost,
        stableTieBreakKey: [...selected]
          .sort((left, right) => compareText(left.segmentId, right.segmentId))
          .map((edge) => edge.stableKey)
          .join("|"),
      };
      if (!best || compareObjective(score, best.score) < 0) {
        best = { edges: [...selected], score };
      }
      return;
    }

    const segment = segmentOrder[index];
    for (const edge of edgesBySegment.get(segment.segmentId) ?? []) {
      if (
        selected.some(
          (prior) =>
            prior.staffId === edge.staffId &&
            intervalsOverlap(
              prior.startsAtMs,
              prior.releasesAtMs,
              edge.startsAtMs,
              edge.releasesAtMs,
            ),
        )
      ) {
        continue;
      }
      selected.push(edge);
      visit(index + 1, selected);
      selected.pop();
      if (limitReached) return;
    }
  };

  visit(0, []);
  return { result: limitReached ? null : best, evaluatedStates, limitReached };
}

function normalizedFingerprintMaterial(input: TurnIqHandoffDecisionInput): unknown {
  return {
    engineVersion: TURNIQ_HANDOFF_ENGINE_VERSION,
    policy: input.policy,
    request: {
      ...input.request,
      segments: [...input.request.segments]
        .sort((left, right) => compareText(left.segmentId, right.segmentId))
        .map((segment) => ({
          ...segment,
          serviceLines: [...segment.serviceLines].sort((left, right) =>
            compareText(left.lineId, right.lineId),
          ),
        })),
    },
    snapshot: {
      ...input.snapshot,
      candidates: [...input.snapshot.candidates].sort((left, right) =>
        compareText(left.stableStaffId, right.stableStaffId),
      ),
      staffAvailability: [...input.snapshot.staffAvailability].sort((left, right) =>
        compareText(left.staffId, right.staffId),
      ),
      resources: [...input.snapshot.resources].sort((left, right) =>
        compareText(left.resourceId, right.resourceId),
      ),
    },
  };
}

function performerCredits(
  assignments: readonly TurnIqHandoffSegmentAssignment[],
): readonly TurnIqHandoffPerformerCredit[] {
  const byStaff = new Map<string, { segmentIds: string[]; credit: number }>();
  for (const assignment of assignments) {
    const current = byStaff.get(assignment.staffId) ?? { segmentIds: [], credit: 0 };
    current.segmentIds.push(assignment.segmentId);
    current.credit += assignment.opportunityCreditCents;
    byStaff.set(assignment.staffId, current);
  }
  return [...byStaff.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([staffId, value]) => ({
      staffId,
      segmentIds: value.segmentIds.sort(compareText),
      opportunityCreditCents: value.credit,
      turnsToConsumeOnAttributedWorkCompletion: 1 as const,
    }));
}

export async function decideTurnIqMultiTechnicianHandoff(
  input: TurnIqHandoffDecisionInput,
): Promise<TurnIqHandoffDecisionRecord> {
  const { sharedResourceVerified } = validateTurnIqHandoffDecisionInput(input);
  const fingerprint = await sha256TurnIqHex(
    canonicalTurnIqJson(normalizedFingerprintMaterial(input)),
  );
  const decisionId = `turniq-handoff-${fingerprint.slice(0, 24)}`;
  const { edgesBySegment, candidateTraces } = buildEdges(input);
  const search = searchPlan(input, edgesBySegment);
  if (!search.result) {
    return {
      decisionId,
      salonId: input.request.salonId,
      bookingId: input.request.bookingId,
      policyId: input.policy.policyId,
      policyVersion: input.policy.version,
      snapshotVersion: input.snapshot.snapshotVersion,
      decidedAt: input.snapshot.capturedAt,
      fingerprint,
      assignments: [],
      performers: [],
      reasonCodes: search.limitReached
        ? ["HANDOFF_NO_COMPLETE_PLAN", "HANDOFF_SEARCH_LIMIT_REACHED"]
        : ["HANDOFF_NO_COMPLETE_PLAN"],
      privacySafeExplanation:
        "No safe complete technician handoff is available; front desk review is required.",
      ownerActionRequired: true,
      evaluatedSearchStates: search.evaluatedStates,
      internalTrace: {
        objectiveScore: null,
        candidateTraces,
      },
    };
  }

  const assignments: readonly TurnIqHandoffSegmentAssignment[] =
    search.result.edges
      .map((edge) => ({
        segmentId: edge.segmentId,
        staffId: edge.staffId,
        startsAt: new Date(edge.startsAtMs).toISOString(),
        releasesAt: new Date(edge.releasesAtMs).toISOString(),
        resourceId: edge.resourceId,
        opportunityCreditCents: edge.opportunityCreditCents,
        requestedTechnicianSatisfied: edge.requestedTechnicianSatisfied,
      }))
      .sort((left, right) => compareText(left.segmentId, right.segmentId));
  const performers = performerCredits(assignments);
  const hasRequest = assignments.some(
    (assignment) => assignment.requestedTechnicianSatisfied !== null,
  );
  const hasFallback = assignments.some(
    (assignment) => assignment.requestedTechnicianSatisfied === false,
  );
  const reasonCodes: TurnIqHandoffReasonCode[] = [
    "HANDOFF_COMPLETE_PLAN",
    "HANDOFF_APPOINTMENT_SAFE",
    performers.length > 1 ? "HANDOFF_MULTI_TECH" : "HANDOFF_SINGLE_TECH_CONTINUITY",
  ];
  if (hasRequest) {
    reasonCodes.push(
      hasFallback ? "HANDOFF_REQUEST_FALLBACK" : "HANDOFF_REQUEST_SATISFIED",
    );
  }
  if (sharedResourceVerified) {
    reasonCodes.push("HANDOFF_SHARED_RESOURCE_VERIFIED");
  }

  return {
    decisionId,
    salonId: input.request.salonId,
    bookingId: input.request.bookingId,
    policyId: input.policy.policyId,
    policyVersion: input.policy.version,
    snapshotVersion: input.snapshot.snapshotVersion,
    decidedAt: input.snapshot.capturedAt,
    fingerprint,
    assignments,
    performers,
    reasonCodes,
    privacySafeExplanation:
      performers.length > 1
        ? `Recommend a safe ${performers.length}-technician handoff across ${assignments.length} service segments; each technician receives one turn and only their attributed service credit after completion.`
        : `Recommend one technician for all ${assignments.length} non-overlapping service segments; one turn is consumed after their attributed work is completed.`,
    ownerActionRequired: hasFallback,
    evaluatedSearchStates: search.evaluatedStates,
    internalTrace: {
      objectiveScore: search.result.score,
      candidateTraces,
    },
  };
}
