import { salonYmdOfUtc } from "@/shared/lib/salonTime";
import type {
  TurnIqCandidateInput,
  TurnIqGroupDecisionInput,
  TurnIqGroupDecisionRecord,
  TurnIqGroupObjectiveScore,
  TurnIqGroupPlanAssignment,
  TurnIqGroupReasonCode,
  TurnIqGroupResourceAvailability,
  TurnIqGroupTaskInput,
  TurnIqId,
} from "@/shared/turniq/contracts";
import { assertTurnIqCents } from "@/shared/turniq/contracts";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import { TurnIqContractError } from "@/shared/turniq/singleCustomerEngine";

export const TURNIQ_GROUP_ENGINE_VERSION = 1 as const;
export const TURNIQ_GROUP_MAX_PARTY_SIZE = 12 as const;
export const TURNIQ_GROUP_MAX_SEARCH_STATES = 250_000 as const;

const APPOINTMENT_SAFETY_TARGET_MINUTES = 60;
const MAX_WAIT_MINUTES = 12 * 60;

type NumericScore = readonly [number, number, number, number, number, number];

type GroupEdge = {
  taskId: TurnIqId;
  staffId: TurnIqId;
  resourceIds: readonly TurnIqId[];
  startsAtMs: number;
  releasesAtMs: number;
  waitMinutes: number;
  requestedTechnicianSatisfied: boolean | null;
  requestedFallbackCost: number;
  appointmentSafetyCostMinutes: number;
  fairnessTierCost: number;
  queueCost: number;
  stableKey: string;
};

type PartialScore = {
  requestedFallbackCount: number;
  appointmentSafetyCostMinutes: number;
  maximumWaitMinutes: number;
  totalWaitMinutes: number;
  fairnessTierCost: number;
  queueCost: number;
};

type SearchResult = {
  edges: readonly GroupEdge[];
  score: TurnIqGroupObjectiveScore;
};

function requiredString(value: string, code: string): void {
  if (value.trim() === "") throw new TurnIqContractError(code);
}

function parseIso(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TurnIqContractError(code);
  return parsed;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function numericScore(score: PartialScore): NumericScore {
  return [
    score.requestedFallbackCount,
    score.appointmentSafetyCostMinutes,
    score.maximumWaitMinutes,
    score.totalWaitMinutes,
    score.fairnessTierCost,
    score.queueCost,
  ];
}

function compareNumericScore(left: NumericScore, right: NumericScore): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function compareObjective(
  left: TurnIqGroupObjectiveScore,
  right: TurnIqGroupObjectiveScore,
): number {
  const numeric = compareNumericScore(
    numericScore(left),
    numericScore(right),
  );
  return numeric !== 0
    ? numeric
    : compareText(left.stableTieBreakKey, right.stableTieBreakKey);
}

function validateServiceLines(
  task: TurnIqGroupTaskInput,
  seenLineIds: Set<string>,
): void {
  if (task.serviceLines.length < 1 || task.serviceLines.length > 5) {
    throw new TurnIqContractError("turniq_group_service_lines_out_of_range");
  }
  for (const line of task.serviceLines) {
    requiredString(line.lineId, "turniq_service_line_id_required");
    requiredString(line.serviceId, "turniq_service_id_required");
    requiredString(line.serviceName, "turniq_service_name_required");
    if (seenLineIds.has(line.lineId)) {
      throw new TurnIqContractError("turniq_duplicate_service_line_id");
    }
    seenLineIds.add(line.lineId);
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
    for (const resourceTypeId of line.requiredResourceTypeIds) {
      requiredString(resourceTypeId, "turniq_resource_type_id_required");
    }
  }
}

export function validateTurnIqGroupDecisionInput(
  input: TurnIqGroupDecisionInput,
): void {
  const { policy, request, snapshot } = input;
  if (policy.salonId !== request.salonId) {
    throw new TurnIqContractError("turniq_cross_salon_request");
  }
  if (
    request.tasks.length < 2 ||
    request.tasks.length > TURNIQ_GROUP_MAX_PARTY_SIZE
  ) {
    throw new TurnIqContractError("turniq_group_party_size_out_of_range");
  }
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) {
    throw new TurnIqContractError("turniq_invalid_policy_version");
  }
  assertTurnIqCents(policy.fairnessBandCents, "fairnessBandCents");
  if (policy.fairnessBandCents > 10_000) {
    throw new TurnIqContractError("turniq_fairness_band_out_of_range");
  }
  requiredString(policy.policyId, "turniq_policy_id_required");
  requiredString(request.requestId, "turniq_group_request_id_required");
  requiredString(snapshot.snapshotVersion, "turniq_snapshot_version_required");
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: policy.timezone }).format(0);
  } catch {
    throw new TurnIqContractError("turniq_invalid_policy_timezone");
  }
  const requestedStartMs = parseIso(
    request.requestedStartAt,
    "turniq_invalid_requested_start",
  );
  const capturedAtMs = parseIso(
    snapshot.capturedAt,
    "turniq_invalid_snapshot_timestamp",
  );
  if (
    salonYmdOfUtc(request.requestedStartAt, policy.timezone) !==
      snapshot.businessDate ||
    salonYmdOfUtc(snapshot.capturedAt, policy.timezone) !== snapshot.businessDate ||
    requestedStartMs < capturedAtMs - 60_000
  ) {
    throw new TurnIqContractError("turniq_stale_group_snapshot");
  }

  const taskIds = new Set<string>();
  const serviceLineIds = new Set<string>();
  for (const task of request.tasks) {
    requiredString(task.taskId, "turniq_group_task_id_required");
    if (taskIds.has(task.taskId)) {
      throw new TurnIqContractError("turniq_duplicate_group_task_id");
    }
    taskIds.add(task.taskId);
    validateServiceLines(task, serviceLineIds);
    if (task.requestedTechnician) {
      requiredString(
        task.requestedTechnician.staffId,
        "turniq_requested_staff_id_required",
      );
      requiredString(
        task.requestedTechnician.actorId,
        "turniq_requested_staff_actor_required",
      );
      parseIso(
        task.requestedTechnician.recordedAt,
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
  }
  if (
    availabilityIds.size !== staffIds.size ||
    [...staffIds].some((staffId) => !availabilityIds.has(staffId))
  ) {
    throw new TurnIqContractError("turniq_staff_availability_incomplete");
  }

  const resourceIds = new Set<string>();
  for (const resource of snapshot.resources) {
    requiredString(resource.resourceId, "turniq_resource_id_required");
    requiredString(resource.resourceTypeId, "turniq_resource_type_id_required");
    if (resourceIds.has(resource.resourceId)) {
      throw new TurnIqContractError("turniq_duplicate_resource_id");
    }
    resourceIds.add(resource.resourceId);
    parseIso(resource.availableAt, "turniq_invalid_resource_available_at");
  }
}

export function turnIqGroupCandidateStaticEligible(
  candidate: TurnIqCandidateInput,
  task: TurnIqGroupTaskInput,
): boolean {
  return candidate.checkedIn && candidate.active && !candidate.approvedBreak &&
    !candidate.temporaryHold && !candidate.refusalPenaltyActive &&
    !candidate.manualSafetyHold && candidate.capabilityDataComplete &&
    task.serviceLines.every((line) =>
      candidate.capableServiceIds.includes(line.serviceId),
    );
}

export function turnIqGroupResourceCombinations(
  task: TurnIqGroupTaskInput,
  resources: readonly TurnIqGroupResourceAvailability[],
): readonly (readonly TurnIqGroupResourceAvailability[])[] {
  const requiredTypes = [
    ...new Set(
      task.serviceLines.flatMap((line) => line.requiredResourceTypeIds),
    ),
  ].sort(compareText);
  if (requiredTypes.length === 0) return [[]];
  const combinations: TurnIqGroupResourceAvailability[][] = [];
  const visit = (
    typeIndex: number,
    selected: TurnIqGroupResourceAvailability[],
  ) => {
    if (typeIndex === requiredTypes.length) {
      combinations.push([...selected]);
      return;
    }
    const matches = resources
      .filter(
        (resource) =>
          resource.available &&
          resource.resourceTypeId === requiredTypes[typeIndex] &&
          !selected.some((item) => item.resourceId === resource.resourceId),
      )
      .sort((left, right) => compareText(left.resourceId, right.resourceId));
    for (const resource of matches) {
      selected.push(resource);
      visit(typeIndex + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return combinations;
}

export function turnIqGroupTaskDurationMinutes(
  task: TurnIqGroupTaskInput,
): number {
  return task.serviceLines.reduce(
    (total, line) => total + line.durationMinutes + line.bufferMinutes,
    0,
  );
}

function buildEdges(
  input: TurnIqGroupDecisionInput,
): ReadonlyMap<string, readonly GroupEdge[]> {
  const requestedStartMs = parseIso(
    input.request.requestedStartAt,
    "turniq_invalid_requested_start",
  );
  const capturedAtMs = parseIso(
    input.snapshot.capturedAt,
    "turniq_invalid_snapshot_timestamp",
  );
  const availability = new Map(
    input.snapshot.staffAvailability.map((item) => [
      item.staffId,
      parseIso(item.availableAt, "turniq_invalid_staff_available_at"),
    ]),
  );
  const resourceReadyAt = new Map(
    input.snapshot.resources.map((resource) => [
      resource.resourceId,
      parseIso(resource.availableAt, "turniq_invalid_resource_available_at"),
    ]),
  );
  const edgesByTask = new Map<string, readonly GroupEdge[]>();

  for (const task of input.request.tasks) {
    const eligibleForTask = input.snapshot.candidates.filter((candidate) =>
      turnIqGroupCandidateStaticEligible(candidate, task),
    );
    const minimumFairnessCredit = eligibleForTask.length === 0
      ? 0
      : Math.min(
          ...eligibleForTask.map(
            (candidate) =>
              candidate.serviceCreditSinceCheckInCents +
              candidate.fairnessBaselineCents,
          ),
        );
    const combinations = turnIqGroupResourceCombinations(
      task,
      input.snapshot.resources,
    );
    const durationMinutes = turnIqGroupTaskDurationMinutes(task);
    const trustedRequestedStaffId =
      task.requestedTechnician &&
      task.requestedTechnician.source !== "legacy_unknown"
        ? task.requestedTechnician.staffId
        : null;
    const taskEdges: GroupEdge[] = [];

    for (const candidate of eligibleForTask) {
      const staffReadyAt = availability.get(candidate.staffId);
      if (staffReadyAt === undefined) continue;
      if (candidate.busy && staffReadyAt <= capturedAtMs) continue;
      for (const resourceSet of combinations) {
        const resourcesReadyAt = resourceSet.reduce(
          (latest, resource) =>
            Math.max(latest, resourceReadyAt.get(resource.resourceId) ?? Infinity),
          requestedStartMs,
        );
        const startsAtMs = Math.max(requestedStartMs, staffReadyAt, resourcesReadyAt);
        const waitMinutes = Math.max(
          0,
          Math.ceil((startsAtMs - requestedStartMs) / 60_000),
        );
        if (
          !Number.isFinite(startsAtMs) ||
          waitMinutes > MAX_WAIT_MINUTES ||
          salonYmdOfUtc(new Date(startsAtMs).toISOString(), input.policy.timezone) !==
            input.snapshot.businessDate
        ) {
          continue;
        }
        const releasesAtMs = startsAtMs + durationMinutes * 60_000;
        let appointmentSafetyCostMinutes = 0;
        if (candidate.nextAppointmentStartsAt) {
          const nextAppointmentMs = parseIso(
            candidate.nextAppointmentStartsAt,
            "turniq_invalid_next_appointment_timestamp",
          );
          if (nextAppointmentMs < startsAtMs || releasesAtMs > nextAppointmentMs) {
            continue;
          }
          const slackMinutes = Math.floor(
            (nextAppointmentMs - releasesAtMs) / 60_000,
          );
          appointmentSafetyCostMinutes = Math.max(
            0,
            APPOINTMENT_SAFETY_TARGET_MINUTES - slackMinutes,
          );
        }
        const fairnessCredit =
          candidate.serviceCreditSinceCheckInCents +
          candidate.fairnessBaselineCents;
        if (!Number.isSafeInteger(fairnessCredit)) {
          throw new TurnIqContractError("turniq_fairness_credit_overflow");
        }
        const fairnessTierCost = Math.floor(
          (fairnessCredit - minimumFairnessCredit) /
            (input.policy.fairnessBandCents + 1),
        );
        const requestedTechnicianSatisfied = trustedRequestedStaffId === null
          ? null
          : candidate.staffId === trustedRequestedStaffId;
        const resourceIds = resourceSet
          .map((resource) => resource.resourceId)
          .sort(compareText);
        taskEdges.push({
          taskId: task.taskId,
          staffId: candidate.staffId,
          resourceIds,
          startsAtMs,
          releasesAtMs,
          waitMinutes,
          requestedTechnicianSatisfied,
          requestedFallbackCost: requestedTechnicianSatisfied === false ? 1 : 0,
          appointmentSafetyCostMinutes,
          fairnessTierCost,
          queueCost: candidate.queuePosition,
          stableKey: [
            task.taskId,
            candidate.stableStaffId,
            resourceIds.join(","),
            new Date(startsAtMs).toISOString(),
          ].join(":"),
        });
      }
    }
    taskEdges.sort((left, right) => {
      const numeric = compareNumericScore(
        [
          left.requestedFallbackCost,
          left.appointmentSafetyCostMinutes,
          left.waitMinutes,
          left.waitMinutes,
          left.fairnessTierCost,
          left.queueCost,
        ],
        [
          right.requestedFallbackCost,
          right.appointmentSafetyCostMinutes,
          right.waitMinutes,
          right.waitMinutes,
          right.fairnessTierCost,
          right.queueCost,
        ],
      );
      return numeric !== 0 ? numeric : compareText(left.stableKey, right.stableKey);
    });
    edgesByTask.set(task.taskId, taskEdges);
  }
  return edgesByTask;
}

function addEdge(score: PartialScore, edge: GroupEdge): PartialScore {
  return {
    requestedFallbackCount:
      score.requestedFallbackCount + edge.requestedFallbackCost,
    appointmentSafetyCostMinutes:
      score.appointmentSafetyCostMinutes + edge.appointmentSafetyCostMinutes,
    maximumWaitMinutes: Math.max(score.maximumWaitMinutes, edge.waitMinutes),
    totalWaitMinutes: score.totalWaitMinutes + edge.waitMinutes,
    fairnessTierCost: score.fairnessTierCost + edge.fairnessTierCost,
    queueCost: score.queueCost + edge.queueCost,
  };
}

function searchPlan(
  input: TurnIqGroupDecisionInput,
  edgesByTask: ReadonlyMap<string, readonly GroupEdge[]>,
): { result: SearchResult | null; evaluatedStates: number; limitReached: boolean } {
  const taskOrder = [...input.request.tasks].sort((left, right) => {
    const edgeDifference =
      (edgesByTask.get(left.taskId)?.length ?? 0) -
      (edgesByTask.get(right.taskId)?.length ?? 0);
    return edgeDifference !== 0
      ? edgeDifference
      : compareText(left.taskId, right.taskId);
  });
  let best: SearchResult | null = null;
  let evaluatedStates = 0;
  let limitReached = false;
  const memo = new Map<
    string,
    { numeric: NumericScore; stablePrefix: string }
  >();

  const visit = (
    taskIndex: number,
    selected: GroupEdge[],
    usedStaff: Set<string>,
    usedResources: Set<string>,
    partial: PartialScore,
  ): void => {
    evaluatedStates += 1;
    if (evaluatedStates > TURNIQ_GROUP_MAX_SEARCH_STATES) {
      limitReached = true;
      return;
    }
    if (best) {
      const comparison = compareNumericScore(
        numericScore(partial),
        numericScore(best.score),
      );
      if (comparison > 0) return;
    }
    if (taskIndex === taskOrder.length) {
      const stableTieBreakKey = [...selected]
        .sort((left, right) => compareText(left.taskId, right.taskId))
        .map((edge) => edge.stableKey)
        .join("|");
      const score: TurnIqGroupObjectiveScore = {
        ...partial,
        stableTieBreakKey,
      };
      if (!best || compareObjective(score, best.score) < 0) {
        best = { edges: [...selected], score };
      }
      return;
    }

    const memoKey = [
      taskIndex,
      [...usedStaff].sort(compareText).join(","),
      [...usedResources].sort(compareText).join(","),
    ].join("|");
    const prior = memo.get(memoKey);
    const currentNumeric = numericScore(partial);
    const stablePrefix = [...selected]
      .sort((left, right) => compareText(left.taskId, right.taskId))
      .map((edge) => edge.stableKey)
      .join("|");
    if (prior) {
      const numericComparison = compareNumericScore(prior.numeric, currentNumeric);
      if (
        numericComparison < 0 ||
        (numericComparison === 0 &&
          compareText(prior.stablePrefix, stablePrefix) <= 0)
      ) {
        return;
      }
    }
    memo.set(memoKey, { numeric: currentNumeric, stablePrefix });

    const task = taskOrder[taskIndex];
    const edges = edgesByTask.get(task.taskId) ?? [];
    for (const edge of edges) {
      if (usedStaff.has(edge.staffId)) continue;
      if (edge.resourceIds.some((resourceId) => usedResources.has(resourceId))) {
        continue;
      }
      usedStaff.add(edge.staffId);
      for (const resourceId of edge.resourceIds) usedResources.add(resourceId);
      selected.push(edge);
      visit(
        taskIndex + 1,
        selected,
        usedStaff,
        usedResources,
        addEdge(partial, edge),
      );
      selected.pop();
      usedStaff.delete(edge.staffId);
      for (const resourceId of edge.resourceIds) usedResources.delete(resourceId);
      if (limitReached) return;
    }
  };

  visit(
    0,
    [],
    new Set(),
    new Set(),
    {
      requestedFallbackCount: 0,
      appointmentSafetyCostMinutes: 0,
      maximumWaitMinutes: 0,
      totalWaitMinutes: 0,
      fairnessTierCost: 0,
      queueCost: 0,
    },
  );
  return { result: limitReached ? null : best, evaluatedStates, limitReached };
}

function normalizedFingerprintMaterial(input: TurnIqGroupDecisionInput): unknown {
  return {
    engineVersion: TURNIQ_GROUP_ENGINE_VERSION,
    policy: input.policy,
    request: {
      ...input.request,
      tasks: [...input.request.tasks]
        .sort((left, right) => compareText(left.taskId, right.taskId))
        .map((task) => ({
          ...task,
          serviceLines: [...task.serviceLines]
            .sort((left, right) => compareText(left.lineId, right.lineId))
            .map((line) => ({
              ...line,
              requiredResourceTypeIds: [...line.requiredResourceTypeIds].sort(
                compareText,
              ),
            })),
        })),
    },
    snapshot: {
      ...input.snapshot,
      candidates: [...input.snapshot.candidates]
        .sort((left, right) => compareText(left.stableStaffId, right.stableStaffId))
        .map((candidate) => ({
          ...candidate,
          capableServiceIds: [...candidate.capableServiceIds].sort(compareText),
        })),
      staffAvailability: [...input.snapshot.staffAvailability].sort((left, right) =>
        compareText(left.staffId, right.staffId),
      ),
      resources: [...input.snapshot.resources].sort((left, right) =>
        compareText(left.resourceId, right.resourceId),
      ),
    },
  };
}

function assignmentReasonCodes(edge: GroupEdge): TurnIqGroupReasonCode[] {
  const reasons: TurnIqGroupReasonCode[] = ["GROUP_APPOINTMENT_SAFE"];
  if (edge.resourceIds.length > 0) reasons.push("GROUP_RESOURCE_ASSIGNED");
  if (edge.requestedTechnicianSatisfied === true) {
    reasons.push("GROUP_REQUEST_SATISFIED");
  } else if (edge.requestedTechnicianSatisfied === false) {
    reasons.push("GROUP_REQUEST_FALLBACK");
  }
  if (edge.waitMinutes > 0) reasons.push("GROUP_WAIT_REQUIRED");
  return reasons;
}

function conservativeEta(
  input: TurnIqGroupDecisionInput,
  edges: readonly GroupEdge[],
): TurnIqGroupDecisionRecord["conservativeEta"] {
  if (edges.length === 0) return null;
  const earliestWait = Math.min(...edges.map((edge) => edge.waitMinutes));
  const latestWait = Math.max(...edges.map((edge) => edge.waitMinutes));
  const longestDuration = Math.max(
    ...input.request.tasks.map(turnIqGroupTaskDurationMinutes),
  );
  const confidencePaddingMinutes = Math.max(
    5,
    Math.ceil(longestDuration * 0.15),
  );
  return {
    earliestStartMinutes: Math.max(0, Math.floor(earliestWait / 5) * 5),
    allStartedByMinutes:
      Math.ceil((latestWait + confidencePaddingMinutes) / 5) * 5,
    confidencePaddingMinutes,
  };
}

/**
 * Exact, deterministic simultaneous-group matcher. It never mutates state and
 * fails closed if the bounded search cannot prove an optimal complete plan.
 */
export async function decideTurnIqGroup(
  input: TurnIqGroupDecisionInput,
): Promise<TurnIqGroupDecisionRecord> {
  validateTurnIqGroupDecisionInput(input);
  const fingerprint = await sha256TurnIqHex(
    canonicalTurnIqJson(normalizedFingerprintMaterial(input)),
  );
  if (input.policy.effectiveBusinessDate > input.snapshot.businessDate) {
    return {
      decisionId: `turniq-group-${fingerprint.slice(0, 32)}`,
      salonId: input.request.salonId,
      policyId: input.policy.policyId,
      policyVersion: input.policy.version,
      snapshotVersion: input.snapshot.snapshotVersion,
      decidedAt: input.snapshot.capturedAt,
      fingerprint,
      assignments: [],
      objectiveScore: null,
      reasonCodes: ["GROUP_NO_COMPLETE_MATCH"],
      conservativeEta: null,
      privacySafeExplanation:
        "No safe complete group plan is available from the current salon snapshot.",
      ownerActionRequired: true,
      evaluatedSearchStates: 0,
    };
  }

  const edgesByTask = buildEdges(input);
  const search = searchPlan(input, edgesByTask);
  if (!search.result) {
    const reasonCodes: TurnIqGroupReasonCode[] = ["GROUP_NO_COMPLETE_MATCH"];
    if (search.limitReached) reasonCodes.push("GROUP_SEARCH_LIMIT_REACHED");
    return {
      decisionId: `turniq-group-${fingerprint.slice(0, 32)}`,
      salonId: input.request.salonId,
      policyId: input.policy.policyId,
      policyVersion: input.policy.version,
      snapshotVersion: input.snapshot.snapshotVersion,
      decidedAt: input.snapshot.capturedAt,
      fingerprint,
      assignments: [],
      objectiveScore: null,
      reasonCodes,
      conservativeEta: null,
      privacySafeExplanation: search.limitReached
        ? "This group needs desk review because NailIQ could not prove an optimal safe plan within the bounded search."
        : "No safe complete group plan is available; keep the party together on the waitlist or ask the desk to review alternatives.",
      ownerActionRequired: true,
      evaluatedSearchStates: search.evaluatedStates,
    };
  }

  const orderedEdges = [...search.result.edges].sort((left, right) =>
    compareText(left.taskId, right.taskId),
  );
  const assignments: TurnIqGroupPlanAssignment[] = orderedEdges.map((edge) => ({
    taskId: edge.taskId,
    staffId: edge.staffId,
    startsAt: new Date(edge.startsAtMs).toISOString(),
    releasesAt: new Date(edge.releasesAtMs).toISOString(),
    resourceIds: edge.resourceIds,
    waitMinutes: edge.waitMinutes,
    requestedTechnicianSatisfied: edge.requestedTechnicianSatisfied,
    reasonCodes: assignmentReasonCodes(edge),
  }));
  const eta = conservativeEta(input, orderedEdges);
  const hasFallback = search.result.score.requestedFallbackCount > 0;
  const hasWait = search.result.score.maximumWaitMinutes > 0;
  const reasonCodes: TurnIqGroupReasonCode[] = ["GROUP_COMPLETE_MATCH"];
  if (hasFallback) reasonCodes.push("GROUP_REQUEST_FALLBACK");
  if (hasWait) reasonCodes.push("GROUP_WAIT_REQUIRED");
  return {
    decisionId: `turniq-group-${fingerprint.slice(0, 32)}`,
    salonId: input.request.salonId,
    policyId: input.policy.policyId,
    policyVersion: input.policy.version,
    snapshotVersion: input.snapshot.snapshotVersion,
    decidedAt: input.snapshot.capturedAt,
    fingerprint,
    assignments,
    objectiveScore: search.result.score,
    reasonCodes,
    conservativeEta: eta,
    privacySafeExplanation: [
      `A complete plan is ready for ${assignments.length} guests with ${assignments.length} qualified technicians.`,
      eta
        ? `Estimated starts are about ${eta.earliestStartMinutes}–${eta.allStartedByMinutes} minutes.`
        : "",
      hasFallback
        ? "At least one requested technician is unavailable, so the plan uses a safe alternative."
        : "No owner action is required.",
    ].filter(Boolean).join(" "),
    ownerActionRequired: hasFallback,
    evaluatedSearchStates: search.evaluatedStates,
  };
}
