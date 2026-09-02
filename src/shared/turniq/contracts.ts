/**
 * TurnIQ M0 domain contracts.
 *
 * This module intentionally has no Supabase, Next.js, browser, or provider
 * dependency. It defines the deterministic boundary; it does not assign staff
 * or mutate booking state.
 */

export type TurnIqId = string;
export type TurnIqIsoTimestamp = string;
export type TurnIqBusinessDate = string;
export type TurnIqMoneyCents = number;

export const TURNIQ_FEATURE_FLAG = "turniq_trust_engine_enabled" as const;

export const TURNIQ_REQUEST_SOURCES = [
  "customer_selected",
  "ai_confirmed",
  "staff_entered",
  "in_person",
  "imported",
  "override",
  "legacy_unknown",
] as const;

export type TurnIqRequestedTechSource =
  (typeof TURNIQ_REQUEST_SOURCES)[number];

export type TurnIqRequestTrustLabel =
  | "customer_confirmed"
  | "customer_claim_recorded"
  | "imported_unverified"
  | "manager_override"
  | "legacy_unknown";

export function requestedTechTrustLabel(
  source: TurnIqRequestedTechSource,
): TurnIqRequestTrustLabel {
  switch (source) {
    case "customer_selected":
    case "ai_confirmed":
    case "in_person":
      return "customer_confirmed";
    case "staff_entered":
      return "customer_claim_recorded";
    case "imported":
      return "imported_unverified";
    case "override":
      return "manager_override";
    case "legacy_unknown":
      return "legacy_unknown";
  }
}

export type TurnIqRequestedTechnician = {
  staffId: TurnIqId;
  source: TurnIqRequestedTechSource;
  actorId: TurnIqId;
  recordedAt: TurnIqIsoTimestamp;
};

export const TURNIQ_REASON_CODES = [
  "ELIGIBLE",
  "EXPLICIT_CUSTOMER_REQUEST",
  "NOT_CHECKED_IN",
  "STAFF_INACTIVE",
  "CURRENTLY_BUSY",
  "APPROVED_BREAK",
  "TEMPORARY_HOLD",
  "SKILL_MISMATCH",
  "CAPABILITY_DATA_INCOMPLETE",
  "INSUFFICIENT_APPOINTMENT_GAP",
  "ACTIVE_REFUSAL_PENALTY",
  "MANUAL_SAFETY_HOLD",
  "REQUESTED_TECH_UNAVAILABLE",
  "RESOURCE_UNAVAILABLE",
  "STALE_POLICY_VERSION",
  "STALE_SNAPSHOT",
  "UNVERIFIED_LEGACY_REQUEST_IGNORED",
  "REQUESTED_TECH_PRECEDENCE",
  "HIGHER_OPPORTUNITY_CREDIT",
  "WITHIN_FAIRNESS_BAND_LATER_QUEUE",
  "STABLE_STAFF_ID_TIE_BREAK",
  "NO_ELIGIBLE_CANDIDATE",
] as const;

export type TurnIqReasonCode = (typeof TURNIQ_REASON_CODES)[number];

export type TurnIqPolicyVersion = {
  policyId: TurnIqId;
  salonId: TurnIqId;
  version: number;
  name: string;
  timezone: string;
  effectiveBusinessDate: TurnIqBusinessDate;
  fairnessBandCents: TurnIqMoneyCents;
  opportunityCreditStrategy:
    | "catalog_plus_permitted_addons_before_tax_and_tip";
  lateArrivalBaselineStrategy: "median_eligible_team_credit_at_check_in";
  approvedBreakStrategy: "freeze_queue_position";
  unapprovedDepartureStrategy: "move_to_queue_end";
  unjustifiedRefusalStrategy: "move_to_queue_end";
  customerRejectionStrategy: "no_penalty";
  policyChangesDefaultToNextBusinessDay: true;
};

export type TurnIqServiceLine = {
  lineId: TurnIqId;
  serviceId: TurnIqId;
  serviceName: string;
  catalogPriceCents: TurnIqMoneyCents;
  permittedAddonCents: TurnIqMoneyCents;
  durationMinutes: number;
  bufferMinutes: number;
  requiredResourceTypeIds: readonly TurnIqId[];
};

export type TurnIqAssignmentRequest = {
  requestId: TurnIqId;
  salonId: TurnIqId;
  bookingId: TurnIqId | null;
  requestedStartAt: TurnIqIsoTimestamp;
  partySize: number;
  serviceLines: readonly TurnIqServiceLine[];
  requestedTechnician: TurnIqRequestedTechnician | null;
};

export type TurnIqCandidateInput = {
  staffId: TurnIqId;
  displayName: string;
  stableStaffId: TurnIqId;
  checkInSessionId: TurnIqId;
  checkedInAt: TurnIqIsoTimestamp;
  queuePosition: number;
  checkedIn: boolean;
  active: boolean;
  busy: boolean;
  approvedBreak: boolean;
  temporaryHold: boolean;
  refusalPenaltyActive: boolean;
  manualSafetyHold: boolean;
  capabilityDataComplete: boolean;
  capableServiceIds: readonly TurnIqId[];
  nextAppointmentStartsAt: TurnIqIsoTimestamp | null;
  serviceCreditSinceCheckInCents: TurnIqMoneyCents;
  fairnessBaselineCents: TurnIqMoneyCents;
};

export type TurnIqResourceAvailability = {
  resourceId: TurnIqId;
  resourceTypeId: TurnIqId;
  available: boolean;
};

export type TurnIqDecisionSnapshot = {
  snapshotVersion: string;
  capturedAt: TurnIqIsoTimestamp;
  businessDate: TurnIqBusinessDate;
  candidates: readonly TurnIqCandidateInput[];
  resources: readonly TurnIqResourceAvailability[];
};

export type TurnIqDecisionInput = {
  policy: TurnIqPolicyVersion;
  request: TurnIqAssignmentRequest;
  snapshot: TurnIqDecisionSnapshot;
};

export type TurnIqCandidateTrace = {
  staffId: TurnIqId;
  displayName: string;
  stableStaffId: TurnIqId;
  eligible: boolean;
  reasonCodes: readonly TurnIqReasonCode[];
  queuePosition: number;
  fairnessCreditCents: TurnIqMoneyCents;
  fairnessTier: number | null;
  rank: number | null;
};

export type TurnIqPrivacySafeCandidateTrace = Pick<
  TurnIqCandidateTrace,
  | "staffId"
  | "displayName"
  | "eligible"
  | "reasonCodes"
  | "queuePosition"
  | "rank"
>;

export function toPrivacySafeCandidateTrace(
  trace: TurnIqCandidateTrace,
): TurnIqPrivacySafeCandidateTrace {
  return {
    staffId: trace.staffId,
    displayName: trace.displayName,
    eligible: trace.eligible,
    reasonCodes: trace.reasonCodes,
    queuePosition: trace.queuePosition,
    rank: trace.rank,
  };
}

export type TurnIqInternalDecisionTrace = {
  orderedCandidates: readonly TurnIqCandidateTrace[];
  fairnessBandCents: TurnIqMoneyCents;
  requestTrustLabel: TurnIqRequestTrustLabel | null;
};

export type TurnIqDecisionRecord = {
  decisionId: TurnIqId;
  salonId: TurnIqId;
  recommendedStaffId: TurnIqId | null;
  policyId: TurnIqId;
  policyVersion: number;
  snapshotVersion: string;
  decidedAt: TurnIqIsoTimestamp;
  fingerprint: string;
  decisionReasonCodes: readonly TurnIqReasonCode[];
  candidates: readonly TurnIqCandidateTrace[];
  privacySafeExplanation: string;
  internalTrace: TurnIqInternalDecisionTrace;
};

export type TurnIqDecisionView = Omit<
  TurnIqDecisionRecord,
  "candidates" | "internalTrace"
> & {
  candidates: readonly TurnIqPrivacySafeCandidateTrace[];
};

/**
 * Default client projection. Owner/manager access to the internal trace must
 * be authorized server-side and must never be inferred from this view.
 */
export function toTurnIqDecisionView(
  decision: TurnIqDecisionRecord,
): TurnIqDecisionView {
  return {
    decisionId: decision.decisionId,
    salonId: decision.salonId,
    recommendedStaffId: decision.recommendedStaffId,
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    snapshotVersion: decision.snapshotVersion,
    decidedAt: decision.decidedAt,
    fingerprint: decision.fingerprint,
    decisionReasonCodes: decision.decisionReasonCodes,
    candidates: decision.candidates.map(toPrivacySafeCandidateTrace),
    privacySafeExplanation: decision.privacySafeExplanation,
  };
}

export const TURNIQ_GROUP_OBJECTIVE_ORDER = [
  "feasibility",
  "requested_technician",
  "appointment_safety",
  "customer_wait",
  "fairness_cost",
  "stable_tie_break",
] as const;

export type TurnIqGroupObjective =
  (typeof TURNIQ_GROUP_OBJECTIVE_ORDER)[number];

export const TURNIQ_GROUP_REASON_CODES = [
  "GROUP_COMPLETE_MATCH",
  "GROUP_NO_COMPLETE_MATCH",
  "GROUP_REQUEST_SATISFIED",
  "GROUP_REQUEST_FALLBACK",
  "GROUP_APPOINTMENT_SAFE",
  "GROUP_RESOURCE_ASSIGNED",
  "GROUP_WAIT_REQUIRED",
  "GROUP_SEARCH_LIMIT_REACHED",
] as const;

export type TurnIqGroupReasonCode =
  (typeof TURNIQ_GROUP_REASON_CODES)[number];

export type TurnIqGroupTaskInput = {
  taskId: TurnIqId;
  serviceLines: readonly TurnIqServiceLine[];
  requestedTechnician: TurnIqRequestedTechnician | null;
};

export type TurnIqGroupRequest = {
  requestId: TurnIqId;
  salonId: TurnIqId;
  bookingGroupId: TurnIqId | null;
  requestedStartAt: TurnIqIsoTimestamp;
  tasks: readonly TurnIqGroupTaskInput[];
};

export type TurnIqGroupStaffAvailability = {
  staffId: TurnIqId;
  availableAt: TurnIqIsoTimestamp;
};

export type TurnIqGroupResourceAvailability = TurnIqResourceAvailability & {
  availableAt: TurnIqIsoTimestamp;
};

export type TurnIqGroupDecisionSnapshot = Omit<
  TurnIqDecisionSnapshot,
  "resources"
> & {
  staffAvailability: readonly TurnIqGroupStaffAvailability[];
  resources: readonly TurnIqGroupResourceAvailability[];
};

export type TurnIqGroupDecisionInput = {
  policy: TurnIqPolicyVersion;
  request: TurnIqGroupRequest;
  snapshot: TurnIqGroupDecisionSnapshot;
};

export type TurnIqGroupPlanAssignment = {
  taskId: TurnIqId;
  staffId: TurnIqId;
  startsAt: TurnIqIsoTimestamp;
  releasesAt: TurnIqIsoTimestamp;
  resourceIds: readonly TurnIqId[];
  waitMinutes: number;
  requestedTechnicianSatisfied: boolean | null;
  reasonCodes: readonly TurnIqGroupReasonCode[];
};

export type TurnIqGroupObjectiveScore = {
  requestedFallbackCount: number;
  appointmentSafetyCostMinutes: number;
  maximumWaitMinutes: number;
  totalWaitMinutes: number;
  fairnessTierCost: number;
  queueCost: number;
  stableTieBreakKey: string;
};

export type TurnIqConservativeEta = {
  earliestStartMinutes: number;
  allStartedByMinutes: number;
  confidencePaddingMinutes: number;
};

export type TurnIqGroupDecisionRecord = {
  decisionId: TurnIqId;
  salonId: TurnIqId;
  policyId: TurnIqId;
  policyVersion: number;
  snapshotVersion: string;
  decidedAt: TurnIqIsoTimestamp;
  fingerprint: string;
  assignments: readonly TurnIqGroupPlanAssignment[];
  objectiveScore: TurnIqGroupObjectiveScore | null;
  reasonCodes: readonly TurnIqGroupReasonCode[];
  conservativeEta: TurnIqConservativeEta | null;
  privacySafeExplanation: string;
  ownerActionRequired: boolean;
  evaluatedSearchStates: number;
};

export const TURNIQ_GROUP_TIMING_INTENTS = [
  "start_together",
  "finish_together",
  "smart_wave",
] as const;

export type TurnIqGroupTimingIntent =
  (typeof TURNIQ_GROUP_TIMING_INTENTS)[number];

export const TURNIQ_GROUP_TIMING_REASON_CODES = [
  "TIMING_SIMULATION_ONLY",
  "TIMING_COMPLETE_PLAN",
  "TIMING_NO_COMPLETE_PLAN",
  "TIMING_START_TOGETHER",
  "TIMING_FINISH_TOGETHER",
  "TIMING_SMART_WAVE",
  "TIMING_SHIFT_REQUIRED",
  "TIMING_REQUEST_FALLBACK",
  "TIMING_SEARCH_LIMIT_REACHED",
] as const;

export type TurnIqGroupTimingReasonCode =
  (typeof TURNIQ_GROUP_TIMING_REASON_CODES)[number];

export type TurnIqGroupTimingPreference =
  | {
      intent: "start_together";
      latestStartAt: TurnIqIsoTimestamp;
      cadenceMinutes: 1 | 5 | 15;
    }
  | {
      intent: "finish_together";
      targetFinishAt: TurnIqIsoTimestamp;
    }
  | {
      intent: "smart_wave";
      latestStartAt: TurnIqIsoTimestamp;
      cadenceMinutes: 1 | 5 | 15;
    };

export type TurnIqGroupTimingSimulationInput = {
  decisionInput: TurnIqGroupDecisionInput;
  timing: TurnIqGroupTimingPreference;
};

export type TurnIqGroupTimingAssignment = TurnIqGroupPlanAssignment & {
  waveNumber: number;
};

export type TurnIqGroupTimingObjectiveScore = TurnIqGroupObjectiveScore & {
  waveCount: number;
  latestReleaseMinutes: number;
};

export type TurnIqGroupTimingSimulationRecord = {
  simulationId: TurnIqId;
  salonId: TurnIqId;
  policyId: TurnIqId;
  policyVersion: number;
  snapshotVersion: string;
  simulatedAt: TurnIqIsoTimestamp;
  fingerprint: string;
  intent: TurnIqGroupTimingIntent;
  liveStateChanged: false;
  assignments: readonly TurnIqGroupTimingAssignment[];
  objectiveScore: TurnIqGroupTimingObjectiveScore | null;
  reasonCodes: readonly TurnIqGroupTimingReasonCode[];
  conservativeEta: TurnIqConservativeEta | null;
  privacySafeExplanation: string;
  ownerActionRequired: boolean;
  evaluatedSearchStates: number;
};

export type TurnIqCommandEnvelope = {
  commandId: TurnIqId;
  salonId: TurnIqId;
  deviceId: TurnIqId;
  localSequence: number;
  policyId: TurnIqId;
  policyVersion: number;
  actorId: TurnIqId;
  actorRole:
    | "owner"
    | "admin"
    | "senior"
    | "receptionist"
    | "nail_tech";
  occurredAt: TurnIqIsoTimestamp;
  requestFingerprint: string;
};

export function assertTurnIqCents(
  value: number,
  fieldName: string,
): asserts value is TurnIqMoneyCents {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer in cents`);
  }
}
