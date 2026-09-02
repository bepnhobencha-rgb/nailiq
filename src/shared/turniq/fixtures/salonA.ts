import type {
  TurnIqCandidateInput,
  TurnIqDecisionInput,
  TurnIqGroupDecisionInput,
  TurnIqPolicyVersion,
} from "@/shared/turniq/contracts";

const SALON_ID = "turniq-salon-a";
const BUSINESS_DATE = "2026-09-02";

export const salonATurnPolicyFixture: TurnIqPolicyVersion = {
  policyId: "turniq-salon-a-policy",
  salonId: SALON_ID,
  version: 1,
  name: "Salon A Money-Balanced Rotation Pilot",
  timezone: "America/Vancouver",
  effectiveBusinessDate: BUSINESS_DATE,
  fairnessBandCents: 2_000,
  opportunityCreditStrategy:
    "catalog_plus_permitted_addons_before_tax_and_tip",
  lateArrivalBaselineStrategy: "median_eligible_team_credit_at_check_in",
  approvedBreakStrategy: "freeze_queue_position",
  unapprovedDepartureStrategy: "move_to_queue_end",
  unjustifiedRefusalStrategy: "move_to_queue_end",
  customerRejectionStrategy: "no_penalty",
  policyChangesDefaultToNextBusinessDay: true,
};

function staffCandidate(
  position: number,
  overrides: Partial<TurnIqCandidateInput> = {},
): TurnIqCandidateInput {
  const suffix = String(position).padStart(2, "0");
  return {
    staffId: `turniq-staff-${suffix}`,
    displayName: `Tech ${suffix}`,
    stableStaffId: `turniq-staff-${suffix}`,
    checkInSessionId: `turniq-session-${suffix}`,
    checkedInAt: `2026-09-02T15:${String(position).padStart(2, "0")}:00.000Z`,
    queuePosition: position,
    checkedIn: true,
    active: true,
    busy: false,
    approvedBreak: false,
    temporaryHold: false,
    refusalPenaltyActive: false,
    manualSafetyHold: false,
    capabilityDataComplete: true,
    capableServiceIds: ["classic-manicure", "deluxe-pedicure"],
    nextAppointmentStartsAt: null,
    serviceCreditSinceCheckInCents: (position - 1) * 500,
    fairnessBaselineCents: 6_000,
    ...overrides,
  };
}

export const salonACandidateFixture: readonly TurnIqCandidateInput[] = [
  staffCandidate(1),
  staffCandidate(2, { busy: true }),
  staffCandidate(3, { approvedBreak: true }),
  staffCandidate(4, { capableServiceIds: ["classic-manicure"] }),
  staffCandidate(5, {
    nextAppointmentStartsAt: "2026-09-02T18:30:00.000Z",
  }),
  staffCandidate(6),
  staffCandidate(7),
  staffCandidate(8),
  staffCandidate(9),
  staffCandidate(10),
  staffCandidate(11, { temporaryHold: true }),
  staffCandidate(12, {
    checkedInAt: "2026-09-02T18:00:00.000Z",
    serviceCreditSinceCheckInCents: 0,
    fairnessBaselineCents: 8_500,
  }),
];

export const salonASingleCustomerInputFixture: TurnIqDecisionInput = {
  policy: salonATurnPolicyFixture,
  request: {
    requestId: "turniq-request-001",
    salonId: SALON_ID,
    bookingId: null,
    requestedStartAt: "2026-09-02T18:00:00.000Z",
    partySize: 1,
    serviceLines: [
      {
        lineId: "turniq-line-001",
        serviceId: "deluxe-pedicure",
        serviceName: "Deluxe Pedicure",
        catalogPriceCents: 6_000,
        permittedAddonCents: 2_000,
        durationMinutes: 60,
        bufferMinutes: 10,
        requiredResourceTypeIds: ["pedicure-chair"],
      },
    ],
    requestedTechnician: {
      staffId: "turniq-staff-06",
      source: "staff_entered",
      actorId: "turniq-receptionist-01",
      recordedAt: "2026-09-02T17:58:00.000Z",
    },
  },
  snapshot: {
    snapshotVersion: "salon-a-2026-09-02-v1",
    capturedAt: "2026-09-02T17:59:00.000Z",
    businessDate: BUSINESS_DATE,
    candidates: salonACandidateFixture,
    resources: [
      {
        resourceId: "pedicure-chair-01",
        resourceTypeId: "pedicure-chair",
        available: true,
      },
    ],
  },
};

export const salonAGroupInputFixture: TurnIqGroupDecisionInput = {
  policy: salonATurnPolicyFixture,
  request: {
    requestId: "turniq-group-request-001",
    salonId: SALON_ID,
    bookingGroupId: null,
    requestedStartAt: "2026-09-02T18:00:00.000Z",
    tasks: Array.from({ length: 4 }, (_, index) => ({
      taskId: `turniq-group-task-${String(index + 1).padStart(2, "0")}`,
      serviceLines: [
        {
          lineId: `turniq-group-line-${String(index + 1).padStart(2, "0")}`,
          serviceId: "deluxe-pedicure",
          serviceName: "Deluxe Pedicure",
          catalogPriceCents: 6_000,
          permittedAddonCents: 1_000,
          durationMinutes: 60,
          bufferMinutes: 10,
          requiredResourceTypeIds: ["pedicure-chair"],
        },
      ],
      requestedTechnician: index === 0
        ? {
            staffId: "turniq-staff-06",
            source: "customer_selected" as const,
            actorId: "turniq-customer-group-01",
            recordedAt: "2026-09-02T17:55:00.000Z",
          }
        : null,
    })),
  },
  snapshot: {
    snapshotVersion: "salon-a-group-2026-09-02-v1",
    capturedAt: "2026-09-02T17:59:00.000Z",
    businessDate: BUSINESS_DATE,
    candidates: salonACandidateFixture,
    staffAvailability: salonACandidateFixture.map((candidate) => ({
      staffId: candidate.staffId,
      availableAt: candidate.busy
        ? "2026-09-02T19:30:00.000Z"
        : "2026-09-02T18:00:00.000Z",
    })),
    resources: Array.from({ length: 7 }, (_, index) => ({
      resourceId: `pedicure-chair-${String(index + 1).padStart(2, "0")}`,
      resourceTypeId: "pedicure-chair",
      available: true,
      availableAt: "2026-09-02T18:00:00.000Z",
    })),
  },
};
