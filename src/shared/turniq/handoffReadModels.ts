export type TurnIqHandoffPlanView = {
  id: string;
  bookingId: string;
  status: string;
  stateVersion: number;
  explanation: string;
  ownerActionRequired: boolean;
  canConfirm: boolean;
  fairnessReceiptCount: number;
  performers: readonly {
    performerId: string;
    assignmentId: string;
    staff: { id: string; name: string };
    status: string;
    segmentCount: number;
    fairnessReceiptId: string | null;
    segments: readonly {
      segmentId: string;
      serviceName: string;
      resourceName: string | null;
      startsAt: string;
      releasesAt: string;
      requestedFallback: boolean;
    }[];
  }[];
};

export type TurnIqHandoffQueueView = {
  businessDate: string;
  bookings: readonly {
    bookingId: string;
    segmentCount: number;
    serviceSummary: string;
    startsAt: string;
    existingPlanId: string | null;
    existingPlanStatus: string | null;
    readiness: "ready" | "assignment_differs" | "unsupported";
  }[];
};

/** Desk-safe: no peer money, objective score, internal trace or customer PII. */
export function projectTurnIqHandoffPlan(input: {
  plan: {
    id: string;
    bookingId: string;
    status: string;
    stateVersion: number;
    explanation: string;
  };
  performers: readonly {
    id: string;
    assignmentId: string;
    staffId: string;
    status: string;
    segmentCount: number;
    requestedFallback: boolean;
    fairnessReceiptId: string | null;
  }[];
  items: readonly {
    performerId: string;
    segmentId: string;
    serviceName: string;
    resourceId: string | null;
    startsAt: string;
    releasesAt: string;
    requestedFallback: boolean;
  }[];
  staff: readonly { id: string; name: string }[];
  resources: readonly { id: string; name: string }[];
}): TurnIqHandoffPlanView {
  const staff = new Map(input.staff.map((row) => [row.id, row.name]));
  const resources = new Map(input.resources.map((row) => [row.id, row.name]));
  const fallback = input.performers.some((row) => row.requestedFallback);
  return {
    id: input.plan.id,
    bookingId: input.plan.bookingId,
    status: input.plan.status,
    stateVersion: input.plan.stateVersion,
    explanation: input.plan.explanation,
    ownerActionRequired: fallback,
    canConfirm: input.plan.status === "recommended" && !fallback,
    fairnessReceiptCount: input.performers.filter((row) => row.fairnessReceiptId).length,
    performers: input.performers.map((performer) => ({
      performerId: performer.id,
      assignmentId: performer.assignmentId,
      staff: {
        id: performer.staffId,
        name: staff.get(performer.staffId) ?? "Assigned technician",
      },
      status: performer.status,
      segmentCount: performer.segmentCount,
      fairnessReceiptId: performer.fairnessReceiptId,
      segments: input.items
        .filter((item) => item.performerId === performer.id)
        .map((item) => ({
          segmentId: item.segmentId,
          serviceName: item.serviceName,
          resourceName: item.resourceId
            ? resources.get(item.resourceId) ?? "Assigned resource"
            : null,
          startsAt: item.startsAt,
          releasesAt: item.releasesAt,
          requestedFallback: item.requestedFallback,
        })),
    })),
  };
}
