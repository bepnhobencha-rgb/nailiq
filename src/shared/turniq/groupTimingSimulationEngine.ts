import { salonYmdOfUtc } from "@/shared/lib/salonTime";
import type {
  TurnIqConservativeEta,
  TurnIqGroupDecisionInput,
  TurnIqGroupPlanAssignment,
  TurnIqGroupResourceAvailability,
  TurnIqGroupTaskInput,
  TurnIqGroupTimingAssignment,
  TurnIqGroupTimingObjectiveScore,
  TurnIqGroupTimingPreference,
  TurnIqGroupTimingReasonCode,
  TurnIqGroupTimingSimulationInput,
  TurnIqGroupTimingSimulationRecord,
  TurnIqId,
} from "@/shared/turniq/contracts";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import {
  turnIqGroupCandidateStaticEligible,
  turnIqGroupResourceCombinations,
  turnIqGroupTaskDurationMinutes,
  validateTurnIqGroupDecisionInput,
} from "@/shared/turniq/groupMatchingEngine";
import { TurnIqContractError } from "@/shared/turniq/singleCustomerEngine";

export const TURNIQ_GROUP_TIMING_ENGINE_VERSION = 1 as const;
export const TURNIQ_GROUP_TIMING_MAX_SEARCH_STATES = 350_000 as const;

const MINUTE_MS = 60_000;
const MAX_TIMING_WINDOW_MINUTES = 12 * 60;
const APPOINTMENT_SAFETY_TARGET_MINUTES = 60;

function deterministicSimulationUuid(fingerprint: string): string {
  // RFC 4122-shaped deterministic UUID derived from the simulation hash. The
  // full SHA-256 remains the collision-resistant identity and is verified
  // separately before persistence.
  const hex = fingerprint.slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

type TimingEdge = {
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
  opportunityCreditCents: number;
  queueCost: number;
  stableKey: string;
};

type PartialScore = Omit<
  TurnIqGroupTimingObjectiveScore,
  "stableTieBreakKey" | "waveCount" | "latestReleaseMinutes"
> & {
  latestReleaseMinutes: number;
};

type SearchResult = {
  edges: readonly TimingEdge[];
  score: TurnIqGroupTimingObjectiveScore;
};

type NumericScore = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function parseIso(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TurnIqContractError(code);
  return parsed;
}

function numericScore(score: {
  requestedFallbackCount: number;
  appointmentSafetyCostMinutes: number;
  maximumWaitMinutes: number;
  totalWaitMinutes: number;
  latestReleaseMinutes: number;
  fairnessTierCost: number;
  queueCost: number;
  waveCount: number;
}): NumericScore {
  return [
    score.requestedFallbackCount,
    score.appointmentSafetyCostMinutes,
    score.maximumWaitMinutes,
    score.totalWaitMinutes,
    score.latestReleaseMinutes,
    score.fairnessTierCost,
    score.queueCost,
    score.waveCount,
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
  left: TurnIqGroupTimingObjectiveScore,
  right: TurnIqGroupTimingObjectiveScore,
): number {
  const numeric = compareNumericScore(numericScore(left), numericScore(right));
  return numeric !== 0
    ? numeric
    : compareText(left.stableTieBreakKey, right.stableTieBreakKey);
}

function candidateStartGrid(
  requestedStartMs: number,
  latestStartMs: number,
  cadenceMinutes: 1 | 5 | 15,
): readonly number[] {
  const cadenceMs = cadenceMinutes * MINUTE_MS;
  const starts = new Set<number>([requestedStartMs]);
  let cursor = Math.ceil(requestedStartMs / cadenceMs) * cadenceMs;
  if (cursor === requestedStartMs) cursor += cadenceMs;
  while (cursor <= latestStartMs) {
    starts.add(cursor);
    cursor += cadenceMs;
  }
  return [...starts].sort((left, right) => left - right);
}

function validateTiming(
  input: TurnIqGroupDecisionInput,
  timing: TurnIqGroupTimingPreference,
): void {
  const requestedStartMs = parseIso(
    input.request.requestedStartAt,
    "turniq_invalid_requested_start",
  );
  const businessDate = input.snapshot.businessDate;
  const timezone = input.policy.timezone;
  if (timing.intent === "finish_together") {
    const finishMs = parseIso(
      timing.targetFinishAt,
      "turniq_invalid_group_target_finish",
    );
    if (
      finishMs <= requestedStartMs ||
      finishMs - requestedStartMs > MAX_TIMING_WINDOW_MINUTES * MINUTE_MS ||
      salonYmdOfUtc(timing.targetFinishAt, timezone) !== businessDate
    ) {
      throw new TurnIqContractError("turniq_group_target_finish_out_of_range");
    }
    return;
  }
  const latestStartMs = parseIso(
    timing.latestStartAt,
    "turniq_invalid_group_latest_start",
  );
  if (
    latestStartMs < requestedStartMs ||
    latestStartMs - requestedStartMs > MAX_TIMING_WINDOW_MINUTES * MINUTE_MS ||
    salonYmdOfUtc(timing.latestStartAt, timezone) !== businessDate
  ) {
    throw new TurnIqContractError("turniq_group_latest_start_out_of_range");
  }
  if (![1, 5, 15].includes(timing.cadenceMinutes)) {
    throw new TurnIqContractError("turniq_invalid_group_timing_cadence");
  }
}

function taskStartCandidates(
  task: TurnIqGroupTaskInput,
  requestedStartMs: number,
  timing: TurnIqGroupTimingPreference,
): readonly number[] {
  if (timing.intent === "finish_together") {
    const finishMs = parseIso(
      timing.targetFinishAt,
      "turniq_invalid_group_target_finish",
    );
    return [finishMs - turnIqGroupTaskDurationMinutes(task) * MINUTE_MS];
  }
  return candidateStartGrid(
    requestedStartMs,
    parseIso(timing.latestStartAt, "turniq_invalid_group_latest_start"),
    timing.cadenceMinutes,
  );
}

function buildEdges(
  input: TurnIqGroupDecisionInput,
  timing: TurnIqGroupTimingPreference,
): ReadonlyMap<string, readonly TimingEdge[]> {
  const requestedStartMs = parseIso(
    input.request.requestedStartAt,
    "turniq_invalid_requested_start",
  );
  const capturedAtMs = parseIso(
    input.snapshot.capturedAt,
    "turniq_invalid_snapshot_timestamp",
  );
  const staffReadyAt = new Map(
    input.snapshot.staffAvailability.map((availability) => [
      availability.staffId,
      parseIso(availability.availableAt, "turniq_invalid_staff_available_at"),
    ]),
  );
  const resourceReadyAt = new Map(
    input.snapshot.resources.map((resource) => [
      resource.resourceId,
      parseIso(resource.availableAt, "turniq_invalid_resource_available_at"),
    ]),
  );
  const edgesByTask = new Map<string, readonly TimingEdge[]>();

  for (const task of input.request.tasks) {
    const eligibleCandidates = input.snapshot.candidates.filter((candidate) =>
      turnIqGroupCandidateStaticEligible(candidate, task),
    );
    const minimumFairnessCredit = eligibleCandidates.length === 0
      ? 0
      : Math.min(
          ...eligibleCandidates.map(
            (candidate) =>
              candidate.serviceCreditSinceCheckInCents +
              candidate.fairnessBaselineCents,
          ),
        );
    const resourceSets = turnIqGroupResourceCombinations(
      task,
      input.snapshot.resources,
    );
    const durationMinutes = turnIqGroupTaskDurationMinutes(task);
    const trustedRequestedStaffId =
      task.requestedTechnician &&
      task.requestedTechnician.source !== "legacy_unknown"
        ? task.requestedTechnician.staffId
        : null;
    const starts = taskStartCandidates(task, requestedStartMs, timing);
    const taskEdges: TimingEdge[] = [];

    for (const candidate of eligibleCandidates) {
      const availableAt = staffReadyAt.get(candidate.staffId);
      if (availableAt === undefined) continue;
      if (candidate.busy && availableAt <= capturedAtMs) continue;
      const fairnessCredit =
        candidate.serviceCreditSinceCheckInCents + candidate.fairnessBaselineCents;
      if (!Number.isSafeInteger(fairnessCredit)) {
        throw new TurnIqContractError("turniq_fairness_credit_overflow");
      }
      const fairnessTierCost = Math.floor(
        (fairnessCredit - minimumFairnessCredit) /
          (input.policy.fairnessBandCents + 1),
      );

      for (const resourceSet of resourceSets) {
        const resourceAvailableAt = resourceSet.reduce(
          (latest, resource) =>
            Math.max(latest, resourceReadyAt.get(resource.resourceId) ?? Infinity),
          requestedStartMs,
        );
        for (const startsAtMs of starts) {
          if (
            startsAtMs < requestedStartMs ||
            startsAtMs < availableAt ||
            startsAtMs < resourceAvailableAt ||
            salonYmdOfUtc(
              new Date(startsAtMs).toISOString(),
              input.policy.timezone,
            ) !== input.snapshot.businessDate
          ) {
            continue;
          }
          const releasesAtMs = startsAtMs + durationMinutes * MINUTE_MS;
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
              (nextAppointmentMs - releasesAtMs) / MINUTE_MS,
            );
            appointmentSafetyCostMinutes = Math.max(
              0,
              APPOINTMENT_SAFETY_TARGET_MINUTES - slackMinutes,
            );
          }
          const requestedTechnicianSatisfied = trustedRequestedStaffId === null
            ? null
            : candidate.staffId === trustedRequestedStaffId;
          const resourceIds = resourceSet
            .map((resource: TurnIqGroupResourceAvailability) => resource.resourceId)
            .sort(compareText);
          taskEdges.push({
            taskId: task.taskId,
            staffId: candidate.staffId,
            resourceIds,
            startsAtMs,
            releasesAtMs,
            waitMinutes: Math.ceil((startsAtMs - requestedStartMs) / MINUTE_MS),
            requestedTechnicianSatisfied,
            requestedFallbackCost:
              requestedTechnicianSatisfied === false ? 1 : 0,
            appointmentSafetyCostMinutes,
            fairnessTierCost,
            opportunityCreditCents: task.serviceLines.reduce(
              (total, line) =>
                total + line.catalogPriceCents + line.permittedAddonCents,
              0,
            ),
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
    }

    taskEdges.sort((left, right) => {
      const numeric = compareNumericScore(
        [
          left.requestedFallbackCost,
          left.appointmentSafetyCostMinutes,
          left.waitMinutes,
          left.waitMinutes,
          Math.ceil((left.releasesAtMs - requestedStartMs) / MINUTE_MS),
          left.fairnessTierCost,
          left.queueCost,
          1,
        ],
        [
          right.requestedFallbackCost,
          right.appointmentSafetyCostMinutes,
          right.waitMinutes,
          right.waitMinutes,
          Math.ceil((right.releasesAtMs - requestedStartMs) / MINUTE_MS),
          right.fairnessTierCost,
          right.queueCost,
          1,
        ],
      );
      return numeric !== 0 ? numeric : compareText(left.stableKey, right.stableKey);
    });
    edgesByTask.set(task.taskId, taskEdges);
  }
  return edgesByTask;
}

function intervalsOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function edgeConflicts(
  edge: TimingEdge,
  selected: readonly TimingEdge[],
  timing: TurnIqGroupTimingPreference,
): boolean {
  if (
    timing.intent === "start_together" &&
    selected.length > 0 &&
    selected[0].startsAtMs !== edge.startsAtMs
  ) {
    return true;
  }
  return selected.some((prior) => {
    if (
      !intervalsOverlap(
        edge.startsAtMs,
        edge.releasesAtMs,
        prior.startsAtMs,
        prior.releasesAtMs,
      )
    ) {
      return false;
    }
    return (
      edge.staffId === prior.staffId ||
      edge.resourceIds.some((resourceId) => prior.resourceIds.includes(resourceId))
    );
  });
}

function addEdge(
  score: PartialScore,
  edge: TimingEdge,
  requestedStartMs: number,
  selected: readonly TimingEdge[],
  fairnessBandCents: number,
): PartialScore {
  const priorPlannedCredit = selected
    .filter((prior) => prior.staffId === edge.staffId)
    .reduce((total, prior) => total + prior.opportunityCreditCents, 0);
  const projectedRepeatTierCost = Math.floor(
    priorPlannedCredit / (fairnessBandCents + 1),
  );
  return {
    requestedFallbackCount:
      score.requestedFallbackCount + edge.requestedFallbackCost,
    appointmentSafetyCostMinutes:
      score.appointmentSafetyCostMinutes + edge.appointmentSafetyCostMinutes,
    maximumWaitMinutes: Math.max(score.maximumWaitMinutes, edge.waitMinutes),
    totalWaitMinutes: score.totalWaitMinutes + edge.waitMinutes,
    fairnessTierCost:
      score.fairnessTierCost + edge.fairnessTierCost + projectedRepeatTierCost,
    queueCost: score.queueCost + edge.queueCost,
    latestReleaseMinutes: Math.max(
      score.latestReleaseMinutes,
      Math.ceil((edge.releasesAtMs - requestedStartMs) / MINUTE_MS),
    ),
  };
}

function canonicalOccupancy(selected: readonly TimingEdge[]): string {
  return [...selected]
    .map((edge) =>
      [
        edge.staffId,
        edge.resourceIds.join(","),
        edge.startsAtMs,
        edge.releasesAtMs,
      ].join("@"),
    )
    .sort(compareText)
    .join("|");
}

function remainingLowerBound(
  taskOrder: readonly TurnIqGroupTaskInput[],
  taskIndex: number,
  selected: readonly TimingEdge[],
  partial: PartialScore,
  edgesByTask: ReadonlyMap<string, readonly TimingEdge[]>,
  timing: TurnIqGroupTimingPreference,
  requestedStartMs: number,
): NumericScore | null {
  let requestedFallbackCount = partial.requestedFallbackCount;
  let appointmentSafetyCostMinutes = partial.appointmentSafetyCostMinutes;
  let maximumWaitMinutes = partial.maximumWaitMinutes;
  let totalWaitMinutes = partial.totalWaitMinutes;
  let latestReleaseMinutes = partial.latestReleaseMinutes;
  let fairnessTierCost = partial.fairnessTierCost;
  let queueCost = partial.queueCost;

  for (let index = taskIndex; index < taskOrder.length; index += 1) {
    const feasible = (edgesByTask.get(taskOrder[index].taskId) ?? []).filter(
      (edge) => !edgeConflicts(edge, selected, timing),
    );
    if (feasible.length === 0) return null;
    requestedFallbackCount += Math.min(
      ...feasible.map((edge) => edge.requestedFallbackCost),
    );
    appointmentSafetyCostMinutes += Math.min(
      ...feasible.map((edge) => edge.appointmentSafetyCostMinutes),
    );
    const minimumWait = Math.min(...feasible.map((edge) => edge.waitMinutes));
    maximumWaitMinutes = Math.max(maximumWaitMinutes, minimumWait);
    totalWaitMinutes += minimumWait;
    latestReleaseMinutes = Math.max(
      latestReleaseMinutes,
      Math.min(
        ...feasible.map((edge) =>
          Math.ceil((edge.releasesAtMs - requestedStartMs) / MINUTE_MS),
        ),
      ),
    );
    fairnessTierCost += Math.min(
      ...feasible.map((edge) => edge.fairnessTierCost),
    );
    queueCost += Math.min(...feasible.map((edge) => edge.queueCost));
  }

  return [
    requestedFallbackCount,
    appointmentSafetyCostMinutes,
    maximumWaitMinutes,
    totalWaitMinutes,
    latestReleaseMinutes,
    fairnessTierCost,
    queueCost,
    Math.max(1, new Set(selected.map((edge) => edge.startsAtMs)).size),
  ];
}

function searchPlan(
  input: TurnIqGroupDecisionInput,
  timing: TurnIqGroupTimingPreference,
  edgesByTask: ReadonlyMap<string, readonly TimingEdge[]>,
): { result: SearchResult | null; evaluatedStates: number; limitReached: boolean } {
  if (timing.intent === "smart_wave") {
    return searchSmartWavePlan(input, timing, edgesByTask);
  }
  const requestedStartMs = parseIso(
    input.request.requestedStartAt,
    "turniq_invalid_requested_start",
  );
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
  const memo = new Map<string, { numeric: NumericScore; stablePrefix: string }>();

  const visit = (
    taskIndex: number,
    selected: TimingEdge[],
    partial: PartialScore,
  ): void => {
    evaluatedStates += 1;
    if (evaluatedStates > TURNIQ_GROUP_TIMING_MAX_SEARCH_STATES) {
      limitReached = true;
      return;
    }
    const partialNumeric = numericScore({
      ...partial,
      waveCount: new Set(selected.map((edge) => edge.startsAtMs)).size,
    });
    if (best && compareNumericScore(partialNumeric, numericScore(best.score)) > 0) {
      return;
    }
    if (taskIndex === taskOrder.length) {
      const stableTieBreakKey = [...selected]
        .sort((left, right) => compareText(left.taskId, right.taskId))
        .map((edge) => edge.stableKey)
        .join("|");
      const score: TurnIqGroupTimingObjectiveScore = {
        ...partial,
        waveCount: new Set(selected.map((edge) => edge.startsAtMs)).size,
        stableTieBreakKey,
      };
      if (!best || compareObjective(score, best.score) < 0) {
        best = { edges: [...selected], score };
      }
      return;
    }

    if (best) {
      const lowerBound = remainingLowerBound(
        taskOrder,
        taskIndex,
        selected,
        partial,
        edgesByTask,
        timing,
        requestedStartMs,
      );
      if (
        lowerBound === null ||
        compareNumericScore(lowerBound, numericScore(best.score)) > 0
      ) {
        return;
      }
    }

    const stablePrefix = [...selected]
      .sort((left, right) => compareText(left.taskId, right.taskId))
      .map((edge) => edge.stableKey)
      .join("|");
    const memoKey = [taskIndex, canonicalOccupancy(selected)].join("|");
    const prior = memo.get(memoKey);
    if (prior) {
      const comparison = compareNumericScore(prior.numeric, partialNumeric);
      if (
        comparison < 0 ||
        (comparison === 0 && compareText(prior.stablePrefix, stablePrefix) <= 0)
      ) {
        return;
      }
    }
    memo.set(memoKey, { numeric: partialNumeric, stablePrefix });

    const task = taskOrder[taskIndex];
    for (const edge of edgesByTask.get(task.taskId) ?? []) {
      if (edgeConflicts(edge, selected, timing)) continue;
      const nextPartial = addEdge(
        partial,
        edge,
        requestedStartMs,
        selected,
        input.policy.fairnessBandCents,
      );
      selected.push(edge);
      visit(taskIndex + 1, selected, nextPartial);
      selected.pop();
      if (limitReached) return;
    }
  };

  visit(0, [], {
    requestedFallbackCount: 0,
    appointmentSafetyCostMinutes: 0,
    maximumWaitMinutes: 0,
    totalWaitMinutes: 0,
    fairnessTierCost: 0,
    queueCost: 0,
    latestReleaseMinutes: 0,
  });
  return {
    result: limitReached ? null : best,
    evaluatedStates,
    limitReached,
  };
}

function earliestPlacementPerLane(
  edges: readonly TimingEdge[],
  selected: readonly TimingEdge[],
  timing: TurnIqGroupTimingPreference,
): readonly TimingEdge[] {
  const earliest = new Map<string, TimingEdge>();
  for (const edge of edges) {
    if (edgeConflicts(edge, selected, timing)) continue;
    const lane = `${edge.staffId}|${edge.resourceIds.join(",")}`;
    const prior = earliest.get(lane);
    if (
      !prior ||
      edge.startsAtMs < prior.startsAtMs ||
      (edge.startsAtMs === prior.startsAtMs &&
        compareText(edge.stableKey, prior.stableKey) < 0)
    ) {
      earliest.set(lane, edge);
    }
  }
  return [...earliest.values()].sort((left, right) => {
    const numeric = compareNumericScore(
      [
        left.requestedFallbackCost,
        left.appointmentSafetyCostMinutes,
        left.waitMinutes,
        left.waitMinutes,
        left.releasesAtMs,
        left.fairnessTierCost,
        left.queueCost,
        1,
      ],
      [
        right.requestedFallbackCost,
        right.appointmentSafetyCostMinutes,
        right.waitMinutes,
        right.waitMinutes,
        right.releasesAtMs,
        right.fairnessTierCost,
        right.queueCost,
        1,
      ],
    );
    return numeric !== 0 ? numeric : compareText(left.stableKey, right.stableKey);
  });
}

function homogeneousUnrequestedTasks(
  tasks: readonly TurnIqGroupTaskInput[],
): boolean {
  if (tasks.length === 0) return false;
  const signature = (task: TurnIqGroupTaskInput) =>
    canonicalTurnIqJson(
      [...task.serviceLines]
        .sort((left, right) => compareText(left.lineId, right.lineId))
        .map((line) => ({
          serviceId: line.serviceId,
          catalogPriceCents: line.catalogPriceCents,
          permittedAddonCents: line.permittedAddonCents,
          durationMinutes: line.durationMinutes,
          bufferMinutes: line.bufferMinutes,
          requiredResourceTypeIds: [...line.requiredResourceTypeIds].sort(
            compareText,
          ),
        })),
    );
  const first = signature(tasks[0]);
  return tasks.every(
    (task) =>
      (!task.requestedTechnician ||
        task.requestedTechnician.source === "legacy_unknown") &&
      signature(task) === first,
  );
}

function bestHomogeneousWave(
  candidates: readonly TimingEdge[],
  targetCount: number,
  priorAssignments: readonly TimingEdge[],
  fairnessBandCents: number,
): { edges: readonly TimingEdge[]; evaluatedStates: number } | null {
  const byStaff = new Map<string, TimingEdge[]>();
  for (const edge of candidates) {
    const bucket = byStaff.get(edge.staffId) ?? [];
    bucket.push(edge);
    byStaff.set(edge.staffId, bucket);
  }
  const staffOptions = [...byStaff.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([staffId, edges]) => ({
      staffId,
      edges: [...edges].sort((left, right) => compareText(left.stableKey, right.stableKey)),
    }));
  let best: readonly TimingEdge[] | null = null;
  let evaluatedStates = 0;

  const selectionKey = (edges: readonly TimingEdge[]) =>
    [...edges]
      .sort((left, right) => compareText(left.stableKey, right.stableKey))
      .map((edge) => edge.stableKey)
      .join("|");
  const plannedCreditByStaff = new Map<string, number>();
  for (const edge of priorAssignments) {
    plannedCreditByStaff.set(
      edge.staffId,
      (plannedCreditByStaff.get(edge.staffId) ?? 0) + edge.opportunityCreditCents,
    );
  }
  const selectionCost = (edges: readonly TimingEdge[]) => [
    edges.reduce((sum, edge) => sum + edge.appointmentSafetyCostMinutes, 0),
    edges.reduce(
      (sum, edge) =>
        sum + edge.fairnessTierCost +
        Math.floor(
          (plannedCreditByStaff.get(edge.staffId) ?? 0) /
            (fairnessBandCents + 1),
        ),
      0,
    ),
    edges.reduce((sum, edge) => sum + edge.queueCost, 0),
  ] as const;
  const isBetter = (candidateEdges: readonly TimingEdge[]) => {
    if (!best) return true;
    if (candidateEdges.length !== best.length) {
      return candidateEdges.length > best.length;
    }
    const left = selectionCost(candidateEdges);
    const right = selectionCost(best);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index] < right[index];
    }
    return compareText(selectionKey(candidateEdges), selectionKey(best)) < 0;
  };
  const visit = (
    staffIndex: number,
    selected: TimingEdge[],
    usedResources: Set<string>,
  ): void => {
    evaluatedStates += 1;
    if (selected.length === targetCount || staffIndex === staffOptions.length) {
      if (isBetter(selected)) best = [...selected];
      return;
    }
    if (selected.length + staffOptions.length - staffIndex < (best?.length ?? 0)) {
      return;
    }
    const option = staffOptions[staffIndex];
    for (const edge of option.edges) {
      if (edge.resourceIds.some((resourceId) => usedResources.has(resourceId))) {
        continue;
      }
      selected.push(edge);
      for (const resourceId of edge.resourceIds) usedResources.add(resourceId);
      visit(staffIndex + 1, selected, usedResources);
      selected.pop();
      for (const resourceId of edge.resourceIds) usedResources.delete(resourceId);
    }
    visit(staffIndex + 1, selected, usedResources);
  };

  visit(0, [], new Set());
  const resolvedBest = best as readonly TimingEdge[] | null;
  return resolvedBest && resolvedBest.length > 0
    ? { edges: resolvedBest, evaluatedStates }
    : null;
}

function searchHomogeneousSmartWavePlan(
  input: TurnIqGroupDecisionInput,
  timing: Extract<TurnIqGroupTimingPreference, { intent: "smart_wave" }>,
  edgesByTask: ReadonlyMap<string, readonly TimingEdge[]>,
): { result: SearchResult | null; evaluatedStates: number; limitReached: boolean } {
  const requestedStartMs = parseIso(
    input.request.requestedStartAt,
    "turniq_invalid_requested_start",
  );
  const prototypeTaskId = [...input.request.tasks]
    .sort((left, right) => compareText(left.taskId, right.taskId))[0].taskId;
  const starts = candidateStartGrid(
    requestedStartMs,
    parseIso(timing.latestStartAt, "turniq_invalid_group_latest_start"),
    timing.cadenceMinutes,
  );
  const remainingTaskIds = input.request.tasks
    .map((task) => task.taskId)
    .sort(compareText);
  const selected: TimingEdge[] = [];
  let evaluatedStates = 0;
  let partial: PartialScore = {
    requestedFallbackCount: 0,
    appointmentSafetyCostMinutes: 0,
    maximumWaitMinutes: 0,
    totalWaitMinutes: 0,
    fairnessTierCost: 0,
    queueCost: 0,
    latestReleaseMinutes: 0,
  };

  for (const startMs of starts) {
    if (remainingTaskIds.length === 0) break;
    const candidates = (edgesByTask.get(prototypeTaskId) ?? []).filter(
      (edge) =>
        edge.startsAtMs === startMs &&
        !edgeConflicts(edge, selected, timing),
    );
    const wave = bestHomogeneousWave(
      candidates,
      remainingTaskIds.length,
      selected,
      input.policy.fairnessBandCents,
    );
    if (!wave) continue;
    evaluatedStates += wave.evaluatedStates;
    if (evaluatedStates > TURNIQ_GROUP_TIMING_MAX_SEARCH_STATES) {
      return { result: null, evaluatedStates, limitReached: true };
    }
    for (const prototype of wave.edges) {
      const taskId = remainingTaskIds.shift();
      if (!taskId) break;
      const edge: TimingEdge = {
        ...prototype,
        taskId,
        stableKey: [taskId, ...prototype.stableKey.split(":").slice(1)].join(":"),
      };
      partial = addEdge(
        partial,
        edge,
        requestedStartMs,
        selected,
        input.policy.fairnessBandCents,
      );
      selected.push(edge);
    }
  }

  if (remainingTaskIds.length > 0) {
    return { result: null, evaluatedStates, limitReached: false };
  }
  const stableTieBreakKey = [...selected]
    .sort((left, right) => compareText(left.taskId, right.taskId))
    .map((edge) => edge.stableKey)
    .join("|");
  return {
    result: {
      edges: selected,
      score: {
        ...partial,
        waveCount: new Set(selected.map((edge) => edge.startsAtMs)).size,
        stableTieBreakKey,
      },
    },
    evaluatedStates,
    limitReached: false,
  };
}

function searchSmartWavePlan(
  input: TurnIqGroupDecisionInput,
  timing: Extract<TurnIqGroupTimingPreference, { intent: "smart_wave" }>,
  edgesByTask: ReadonlyMap<string, readonly TimingEdge[]>,
): { result: SearchResult | null; evaluatedStates: number; limitReached: boolean } {
  if (
    homogeneousUnrequestedTasks(input.request.tasks) &&
    input.snapshot.candidates.every(
      (candidate) => candidate.nextAppointmentStartsAt === null,
    )
  ) {
    return searchHomogeneousSmartWavePlan(input, timing, edgesByTask);
  }
  const requestedStartMs = parseIso(
    input.request.requestedStartAt,
    "turniq_invalid_requested_start",
  );
  const taskById = new Map(input.request.tasks.map((task) => [task.taskId, task]));
  let best: SearchResult | null = null;
  let evaluatedStates = 0;
  let limitReached = false;
  const memo = new Map<string, { numeric: NumericScore; stablePrefix: string }>();

  const visit = (
    remainingTaskIds: readonly string[],
    selected: TimingEdge[],
    partial: PartialScore,
  ): void => {
    evaluatedStates += 1;
    if (evaluatedStates > TURNIQ_GROUP_TIMING_MAX_SEARCH_STATES) {
      limitReached = true;
      return;
    }
    const partialNumeric = numericScore({
      ...partial,
      waveCount: new Set(selected.map((edge) => edge.startsAtMs)).size,
    });
    if (best && compareNumericScore(partialNumeric, numericScore(best.score)) > 0) {
      return;
    }
    if (remainingTaskIds.length === 0) {
      const stableTieBreakKey = [...selected]
        .sort((left, right) => compareText(left.taskId, right.taskId))
        .map((edge) => edge.stableKey)
        .join("|");
      const score: TurnIqGroupTimingObjectiveScore = {
        ...partial,
        waveCount: new Set(selected.map((edge) => edge.startsAtMs)).size,
        stableTieBreakKey,
      };
      if (!best || compareObjective(score, best.score) < 0) {
        best = { edges: [...selected], score };
      }
      return;
    }

    const remainingTasks = remainingTaskIds
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is TurnIqGroupTaskInput => task !== undefined);
    if (best) {
      const lowerBound = remainingLowerBound(
        remainingTasks,
        0,
        selected,
        partial,
        edgesByTask,
        timing,
        requestedStartMs,
      );
      if (
        lowerBound === null ||
        compareNumericScore(lowerBound, numericScore(best.score)) > 0
      ) {
        return;
      }
    }

    const stablePrefix = [...selected]
      .sort((left, right) => compareText(left.taskId, right.taskId))
      .map((edge) => edge.stableKey)
      .join("|");
    const memoKey = [
      [...remainingTaskIds].sort(compareText).join(","),
      canonicalOccupancy(selected),
    ].join("|");
    const prior = memo.get(memoKey);
    if (prior) {
      const comparison = compareNumericScore(prior.numeric, partialNumeric);
      if (
        comparison < 0 ||
        (comparison === 0 && compareText(prior.stablePrefix, stablePrefix) <= 0)
      ) {
        return;
      }
    }
    memo.set(memoKey, { numeric: partialNumeric, stablePrefix });

    const taskOptions = remainingTasks
      .map((task) => ({
        task,
        placements: earliestPlacementPerLane(
          edgesByTask.get(task.taskId) ?? [],
          selected,
          timing,
        ),
      }))
      .sort((left, right) =>
        left.placements.length - right.placements.length ||
        compareText(left.task.taskId, right.task.taskId),
      );
    if (taskOptions.some((option) => option.placements.length === 0)) return;

    for (const option of taskOptions) {
      const nextRemaining = remainingTaskIds.filter(
        (taskId) => taskId !== option.task.taskId,
      );
      for (const edge of option.placements) {
        const nextPartial = addEdge(
          partial,
          edge,
          requestedStartMs,
          selected,
          input.policy.fairnessBandCents,
        );
        selected.push(edge);
        visit(
          nextRemaining,
          selected,
          nextPartial,
        );
        selected.pop();
        if (limitReached) return;
      }
    }
  };

  visit(
    input.request.tasks.map((task) => task.taskId),
    [],
    {
      requestedFallbackCount: 0,
      appointmentSafetyCostMinutes: 0,
      maximumWaitMinutes: 0,
      totalWaitMinutes: 0,
      fairnessTierCost: 0,
      queueCost: 0,
      latestReleaseMinutes: 0,
    },
  );
  return {
    result: limitReached ? null : best,
    evaluatedStates,
    limitReached,
  };
}

function assignmentReasonCodes(edge: TimingEdge): TurnIqGroupPlanAssignment["reasonCodes"] {
  const codes: TurnIqGroupPlanAssignment["reasonCodes"][number][] = [
    "GROUP_APPOINTMENT_SAFE",
  ];
  if (edge.resourceIds.length > 0) codes.push("GROUP_RESOURCE_ASSIGNED");
  if (edge.requestedTechnicianSatisfied === true) {
    codes.push("GROUP_REQUEST_SATISFIED");
  } else if (edge.requestedTechnicianSatisfied === false) {
    codes.push("GROUP_REQUEST_FALLBACK");
  }
  if (edge.waitMinutes > 0) codes.push("GROUP_WAIT_REQUIRED");
  return codes;
}

function conservativeEta(
  input: TurnIqGroupDecisionInput,
  edges: readonly TimingEdge[],
): TurnIqConservativeEta | null {
  if (edges.length === 0) return null;
  const earliestWait = Math.min(...edges.map((edge) => edge.waitMinutes));
  const latestWait = Math.max(...edges.map((edge) => edge.waitMinutes));
  const longestDuration = Math.max(
    ...input.request.tasks.map(turnIqGroupTaskDurationMinutes),
  );
  const confidencePaddingMinutes = Math.max(5, Math.ceil(longestDuration * 0.15));
  return {
    earliestStartMinutes: Math.max(0, Math.floor(earliestWait / 5) * 5),
    allStartedByMinutes:
      Math.ceil((latestWait + confidencePaddingMinutes) / 5) * 5,
    confidencePaddingMinutes,
  };
}

function normalizedFingerprintMaterial(
  input: TurnIqGroupTimingSimulationInput,
): unknown {
  return {
    engineVersion: TURNIQ_GROUP_TIMING_ENGINE_VERSION,
    timing: input.timing,
    decisionInput: {
      policy: input.decisionInput.policy,
      request: {
        ...input.decisionInput.request,
        tasks: [...input.decisionInput.request.tasks]
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
        ...input.decisionInput.snapshot,
        candidates: [...input.decisionInput.snapshot.candidates]
          .sort((left, right) =>
            compareText(left.stableStaffId, right.stableStaffId),
          )
          .map((candidate) => ({
            ...candidate,
            capableServiceIds: [...candidate.capableServiceIds].sort(compareText),
          })),
        staffAvailability: [
          ...input.decisionInput.snapshot.staffAvailability,
        ].sort((left, right) => compareText(left.staffId, right.staffId)),
        resources: [...input.decisionInput.snapshot.resources].sort((left, right) =>
          compareText(left.resourceId, right.resourceId),
        ),
      },
    },
  };
}

function noPlanReasonCodes(
  timing: TurnIqGroupTimingPreference,
  limitReached: boolean,
): TurnIqGroupTimingReasonCode[] {
  const codes: TurnIqGroupTimingReasonCode[] = [
    "TIMING_SIMULATION_ONLY",
    "TIMING_NO_COMPLETE_PLAN",
    timing.intent === "start_together"
      ? "TIMING_START_TOGETHER"
      : timing.intent === "finish_together"
        ? "TIMING_FINISH_TOGETHER"
        : "TIMING_SMART_WAVE",
  ];
  if (limitReached) codes.push("TIMING_SEARCH_LIMIT_REACHED");
  return codes;
}

function successExplanation(
  timing: TurnIqGroupTimingPreference,
  assignments: readonly TurnIqGroupTimingAssignment[],
  hasFallback: boolean,
): string {
  const waves = new Set(assignments.map((assignment) => assignment.waveNumber)).size;
  const timingText = timing.intent === "start_together"
    ? "Everyone can start together in one safe plan."
    : timing.intent === "finish_together"
      ? "Service start times are staggered so everyone can finish together."
      : `The group can be served in ${waves} safe wave${waves === 1 ? "" : "s"} with the shortest proven wait.`;
  return [
    "Simulation only — no booking has changed.",
    timingText,
    hasFallback
      ? "At least one requested technician is unavailable, so desk review is required."
      : "No owner action is required to review this option.",
  ].join(" ");
}

/**
 * Pure deterministic group timing simulator. It never writes booking, queue,
 * ledger, resource or provider state. A bounded-search overflow fails closed.
 */
export async function simulateTurnIqGroupTiming(
  input: TurnIqGroupTimingSimulationInput,
): Promise<TurnIqGroupTimingSimulationRecord> {
  validateTurnIqGroupDecisionInput(input.decisionInput);
  validateTiming(input.decisionInput, input.timing);
  const fingerprint = await sha256TurnIqHex(
    canonicalTurnIqJson(normalizedFingerprintMaterial(input)),
  );
  const base = {
    simulationId: deterministicSimulationUuid(fingerprint),
    salonId: input.decisionInput.request.salonId,
    policyId: input.decisionInput.policy.policyId,
    policyVersion: input.decisionInput.policy.version,
    snapshotVersion: input.decisionInput.snapshot.snapshotVersion,
    simulatedAt: input.decisionInput.snapshot.capturedAt,
    fingerprint,
    intent: input.timing.intent,
    liveStateChanged: false as const,
  };

  if (
    input.decisionInput.policy.effectiveBusinessDate >
    input.decisionInput.snapshot.businessDate
  ) {
    return {
      ...base,
      assignments: [],
      objectiveScore: null,
      reasonCodes: noPlanReasonCodes(input.timing, false),
      conservativeEta: null,
      privacySafeExplanation:
        "Simulation only — no booking has changed. The active policy snapshot is not valid for this business day.",
      ownerActionRequired: true,
      evaluatedSearchStates: 0,
    };
  }

  const edgesByTask = buildEdges(input.decisionInput, input.timing);
  const search = searchPlan(input.decisionInput, input.timing, edgesByTask);
  if (!search.result) {
    return {
      ...base,
      assignments: [],
      objectiveScore: null,
      reasonCodes: noPlanReasonCodes(input.timing, search.limitReached),
      conservativeEta: null,
      privacySafeExplanation: search.limitReached
        ? "Simulation only — no booking has changed. NailIQ could not prove the best safe group timing inside the bounded search, so desk review is required."
        : "Simulation only — no booking has changed. No complete safe plan matches this timing preference.",
      ownerActionRequired: true,
      evaluatedSearchStates: search.evaluatedStates,
    };
  }

  const startTimes = [...new Set(search.result.edges.map((edge) => edge.startsAtMs))]
    .sort((left, right) => left - right);
  const waveByStart = new Map(
    startTimes.map((start, index) => [start, index + 1]),
  );
  const assignments: TurnIqGroupTimingAssignment[] = [...search.result.edges]
    .sort((left, right) => compareText(left.taskId, right.taskId))
    .map((edge) => ({
      taskId: edge.taskId,
      staffId: edge.staffId,
      startsAt: new Date(edge.startsAtMs).toISOString(),
      releasesAt: new Date(edge.releasesAtMs).toISOString(),
      resourceIds: edge.resourceIds,
      waitMinutes: edge.waitMinutes,
      requestedTechnicianSatisfied: edge.requestedTechnicianSatisfied,
      reasonCodes: assignmentReasonCodes(edge),
      waveNumber: waveByStart.get(edge.startsAtMs) ?? 1,
    }));
  const hasFallback = search.result.score.requestedFallbackCount > 0;
  const hasShift = assignments.some((assignment) => assignment.waitMinutes > 0);
  const reasonCodes: TurnIqGroupTimingReasonCode[] = [
    "TIMING_SIMULATION_ONLY",
    "TIMING_COMPLETE_PLAN",
    input.timing.intent === "start_together"
      ? "TIMING_START_TOGETHER"
      : input.timing.intent === "finish_together"
        ? "TIMING_FINISH_TOGETHER"
        : "TIMING_SMART_WAVE",
  ];
  if (hasShift) reasonCodes.push("TIMING_SHIFT_REQUIRED");
  if (hasFallback) reasonCodes.push("TIMING_REQUEST_FALLBACK");

  return {
    ...base,
    assignments,
    objectiveScore: search.result.score,
    reasonCodes,
    conservativeEta: conservativeEta(input.decisionInput, search.result.edges),
    privacySafeExplanation: successExplanation(
      input.timing,
      assignments,
      hasFallback,
    ),
    ownerActionRequired: hasFallback,
    evaluatedSearchStates: search.evaluatedStates,
  };
}
