export type TurnIqGroupPlanReadRow = {
  id: string;
  bookingGroupId: string;
  partySize: number;
  requestedStartAt: string;
  decisionTimestamp: string;
  privacySafeExplanation: string;
  conservativeEta: unknown;
  status: string;
  stateVersion: number;
  planningMode: "fixed" | "staggered";
  timingIntent: TurnIqGroupTimingIntent | null;
};

export type TurnIqGroupPlanItemReadRow = {
  assignmentId: string;
  bookingId: string;
  staffId: string;
  serviceId: string;
  resourceId: string | null;
  startsAt: string;
  safeEndAt: string;
  requestedFallback: boolean;
  waitMinutes: number;
  assignmentStatus: string;
  fairnessReceiptId: string | null;
  waveNumber: number | null;
};

export type TurnIqGroupDirectoryEntry = {
  id: string;
  name: string;
};

export type TurnIqGroupEtaView = {
  earliestStartMinutes: number;
  allStartedByMinutes: number;
  confidencePaddingMinutes: number;
};

export type TurnIqGroupPlanView = {
  id: string;
  bookingGroupId: string;
  partySize: number;
  requestedStartAt: string;
  decisionTimestamp: string;
  status: string;
  stateVersion: number;
  planningMode: "fixed" | "staggered";
  timingIntent: TurnIqGroupTimingIntent | null;
  explanation: string;
  eta: TurnIqGroupEtaView | null;
  ownerActionRequired: boolean;
  canConfirm: boolean;
  fairnessReceiptCount: number;
  assignments: readonly {
    assignmentId: string;
    bookingId: string;
    staff: TurnIqGroupDirectoryEntry;
    service: TurnIqGroupDirectoryEntry;
    resource: TurnIqGroupDirectoryEntry | null;
    startsAt: string;
    safeEndAt: string;
    waitMinutes: number;
    requestedFallback: boolean;
    status: string;
    fairnessReceiptId: string | null;
    waveNumber: number | null;
  }[];
};

export type TurnIqGroupQueueItemView = {
  bookingGroupId: string;
  partySize: number;
  requestedStartAt: string;
  serviceSummary: string;
  readiness:
    | "ready"
    | "partially_assigned"
    | "mixed_start_times"
    | "unsupported_schedule";
  existingPlanId: string | null;
  existingPlanStatus: string | null;
};

export type TurnIqGroupQueueView = {
  businessDate: string;
  groups: readonly TurnIqGroupQueueItemView[];
};

export type TurnIqGroupTimingOptionView = {
  simulationId: string;
  simulationFingerprint: string;
  intent: TurnIqGroupTimingIntent;
  feasible: boolean;
  liveStateChanged: false;
  explanation: string;
  ownerActionRequired: boolean;
  eta: TurnIqGroupEtaView | null;
  metrics: {
    waveCount: number;
    maximumWaitMinutes: number;
    totalWaitMinutes: number;
    latestReleaseMinutes: number;
  } | null;
  assignments: readonly {
    taskId: string;
    staff: TurnIqGroupDirectoryEntry;
    serviceSummary: string;
    resourceNames: readonly string[];
    startsAt: string;
    releasesAt: string;
    waitMinutes: number;
    waveNumber: number;
  }[];
};

export type TurnIqGroupTimingComparisonView = {
  bookingGroupId: string;
  snapshotVersion: string;
  comparedAt: string;
  windowMinutes: number;
  finishOffsetMinutes: number;
  liveStateChanged: false;
  options: readonly TurnIqGroupTimingOptionView[];
};

function safeNumber(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function eta(value: unknown): TurnIqGroupEtaView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return {
    earliestStartMinutes: safeNumber(row.earliestStartMinutes),
    allStartedByMinutes: safeNumber(row.allStartedByMinutes),
    confidencePaddingMinutes: safeNumber(row.confidencePaddingMinutes),
  };
}

/**
 * Desk-safe projection. It intentionally omits objective fairness costs,
 * internal traces, peer revenue, tips, decision fingerprints and customer PII.
 */
export function projectTurnIqGroupPlan(input: {
  plan: TurnIqGroupPlanReadRow;
  items: readonly TurnIqGroupPlanItemReadRow[];
  staff: readonly TurnIqGroupDirectoryEntry[];
  services: readonly TurnIqGroupDirectoryEntry[];
  resources: readonly TurnIqGroupDirectoryEntry[];
}): TurnIqGroupPlanView {
  const staff = new Map(input.staff.map((entry) => [entry.id, entry]));
  const services = new Map(input.services.map((entry) => [entry.id, entry]));
  const resources = new Map(input.resources.map((entry) => [entry.id, entry]));
  const fallback = input.items.some((item) => item.requestedFallback);
  return {
    id: input.plan.id,
    bookingGroupId: input.plan.bookingGroupId,
    partySize: input.plan.partySize,
    requestedStartAt: input.plan.requestedStartAt,
    decisionTimestamp: input.plan.decisionTimestamp,
    status: input.plan.status,
    stateVersion: input.plan.stateVersion,
    planningMode: input.plan.planningMode,
    timingIntent: input.plan.timingIntent,
    explanation: input.plan.privacySafeExplanation,
    eta: eta(input.plan.conservativeEta),
    ownerActionRequired: fallback,
    canConfirm: input.plan.status === "recommended" && !fallback,
    fairnessReceiptCount: input.items.filter(
      (item) => item.fairnessReceiptId !== null,
    ).length,
    assignments: input.items.map((item) => ({
      assignmentId: item.assignmentId,
      bookingId: item.bookingId,
      staff: staff.get(item.staffId) ?? {
        id: item.staffId,
        name: "Assigned technician",
      },
      service: services.get(item.serviceId) ?? {
        id: item.serviceId,
        name: "Booked service",
      },
      resource: item.resourceId
        ? resources.get(item.resourceId) ?? {
            id: item.resourceId,
            name: "Assigned resource",
          }
        : null,
      startsAt: item.startsAt,
      safeEndAt: item.safeEndAt,
      waitMinutes: item.waitMinutes,
      requestedFallback: item.requestedFallback,
      status: item.assignmentStatus,
      fairnessReceiptId: item.fairnessReceiptId,
      waveNumber: item.waveNumber,
    })),
  };
}

/** Privacy-safe M4F comparison. Internal fairness money and trace stay server-side. */
export function projectTurnIqGroupTimingSimulation(input: {
  simulation: TurnIqGroupTimingSimulationRecord;
  decisionInput: TurnIqGroupDecisionInput;
}): TurnIqGroupTimingOptionView {
  const tasks = new Map(
    input.decisionInput.request.tasks.map((task) => [task.taskId, task]),
  );
  const staff = new Map(
    input.decisionInput.snapshot.candidates.map((candidate) => [
      candidate.staffId,
      { id: candidate.staffId, name: candidate.displayName },
    ]),
  );
  const resources = new Map(
    input.decisionInput.snapshot.resources.map((resource) => [
      resource.resourceId,
      resource.resourceTypeId,
    ]),
  );
  return {
    simulationId: input.simulation.simulationId,
    simulationFingerprint: input.simulation.fingerprint,
    intent: input.simulation.intent,
    feasible: input.simulation.assignments.length === tasks.size,
    liveStateChanged: false,
    explanation: input.simulation.privacySafeExplanation,
    ownerActionRequired: input.simulation.ownerActionRequired,
    eta: input.simulation.conservativeEta,
    metrics: input.simulation.objectiveScore
      ? {
          waveCount: input.simulation.objectiveScore.waveCount,
          maximumWaitMinutes:
            input.simulation.objectiveScore.maximumWaitMinutes,
          totalWaitMinutes: input.simulation.objectiveScore.totalWaitMinutes,
          latestReleaseMinutes:
            input.simulation.objectiveScore.latestReleaseMinutes,
        }
      : null,
    assignments: input.simulation.assignments.map((assignment) => {
      const task = tasks.get(assignment.taskId);
      return {
        taskId: assignment.taskId,
        staff: staff.get(assignment.staffId) ?? {
          id: assignment.staffId,
          name: "Qualified technician",
        },
        serviceSummary:
          task?.serviceLines.map((line) => line.serviceName).join(" + ") ??
          "Booked service",
        resourceNames: assignment.resourceIds.map(
          (resourceId) => resources.get(resourceId) ?? "Required resource",
        ),
        startsAt: assignment.startsAt,
        releasesAt: assignment.releasesAt,
        waitMinutes: assignment.waitMinutes,
        waveNumber: assignment.waveNumber,
      };
    }),
  };
}
import type {
  TurnIqGroupDecisionInput,
  TurnIqGroupTimingIntent,
  TurnIqGroupTimingSimulationRecord,
} from "@/shared/turniq/contracts";
