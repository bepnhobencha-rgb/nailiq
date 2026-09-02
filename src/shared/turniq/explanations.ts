import type {
  TurnIqCandidateTrace,
  TurnIqDecisionRecord,
  TurnIqReasonCode,
} from "@/shared/turniq/contracts";

const WHY_NOT_REASON_PRIORITY: readonly TurnIqReasonCode[] = [
  "NOT_CHECKED_IN",
  "STAFF_INACTIVE",
  "CURRENTLY_BUSY",
  "APPROVED_BREAK",
  "TEMPORARY_HOLD",
  "CAPABILITY_DATA_INCOMPLETE",
  "SKILL_MISMATCH",
  "INSUFFICIENT_APPOINTMENT_GAP",
  "ACTIVE_REFUSAL_PENALTY",
  "MANUAL_SAFETY_HOLD",
  "RESOURCE_UNAVAILABLE",
  "STALE_POLICY_VERSION",
  "STALE_SNAPSHOT",
  "REQUESTED_TECH_PRECEDENCE",
  "HIGHER_OPPORTUNITY_CREDIT",
  "WITHIN_FAIRNESS_BAND_LATER_QUEUE",
  "STABLE_STAFF_ID_TIE_BREAK",
];

const WHY_NOT_COPY: Partial<Record<TurnIqReasonCode, string>> = {
  NOT_CHECKED_IN: "Not eligible right now: you are not checked in.",
  STAFF_INACTIVE: "Not eligible right now: your staff profile is inactive.",
  CURRENTLY_BUSY: "Not eligible right now: you are currently serving a customer.",
  APPROVED_BREAK: "Not eligible right now: your approved break preserves your queue position.",
  TEMPORARY_HOLD: "Not eligible right now: you are on a temporary hold.",
  CAPABILITY_DATA_INCOMPLETE:
    "Not eligible right now: service qualification data needs review.",
  SKILL_MISMATCH:
    "Not eligible for this customer: the requested service is not enabled for you.",
  INSUFFICIENT_APPOINTMENT_GAP:
    "Not eligible for this customer: there is not enough safe time before your next appointment.",
  ACTIVE_REFUSAL_PENALTY:
    "Not eligible right now: an active refusal penalty is in effect.",
  MANUAL_SAFETY_HOLD:
    "Not eligible right now: a manager safety hold is in effect.",
  RESOURCE_UNAVAILABLE:
    "No technician can be assigned safely until the required resource is available.",
  STALE_POLICY_VERSION:
    "No recommendation is available until the active policy is refreshed.",
  STALE_SNAPSHOT:
    "No recommendation is available until the salon state is refreshed.",
  REQUESTED_TECH_PRECEDENCE:
    "You are eligible, but this customer has a recorded request for another eligible technician.",
  HIGHER_OPPORTUNITY_CREDIT:
    "You are eligible, but another technician is earlier under the salon's opportunity rules.",
  WITHIN_FAIRNESS_BAND_LATER_QUEUE:
    "You are eligible, but another technician is earlier in the active queue within the fairness band.",
  STABLE_STAFF_ID_TIE_BREAK:
    "You are eligible; a stable technical tie-break selected another technician.",
};

/** Privacy-safe, deterministic copy for a technician's one-tap “Why not me?”. */
export function explainWhyNotMe(
  trace: Pick<TurnIqCandidateTrace, "eligible" | "rank" | "reasonCodes">,
): string {
  if (trace.eligible && trace.rank === 1) {
    return "Recommended: you are available, qualified, and appointment-safe.";
  }
  const reason = WHY_NOT_REASON_PRIORITY.find((code) =>
    trace.reasonCodes.includes(code),
  );
  return reason
    ? (WHY_NOT_COPY[reason] ?? "Not recommended under the active salon policy.")
    : "Not recommended under the active salon policy.";
}

/** Public one-line decision summary. Never includes fairness-credit amounts. */
export function explainSingleCustomerDecision(
  recommended: TurnIqCandidateTrace | null,
  decisionReasonCodes: readonly TurnIqReasonCode[],
): string {
  if (!recommended) {
    if (decisionReasonCodes.includes("RESOURCE_UNAVAILABLE")) {
      return "No safe recommendation: the required resource is unavailable.";
    }
    if (decisionReasonCodes.includes("STALE_POLICY_VERSION")) {
      return "No safe recommendation: refresh the active TurnIQ policy.";
    }
    if (decisionReasonCodes.includes("STALE_SNAPSHOT")) {
      return "No safe recommendation: refresh the salon schedule and queue state.";
    }
    return "No safe recommendation: no checked-in technician currently meets all service, schedule, and hold requirements.";
  }

  if (decisionReasonCodes.includes("EXPLICIT_CUSTOMER_REQUEST")) {
    return `Recommend ${recommended.displayName}: the recorded customer request can be honored; they are available, qualified, and appointment-safe.`;
  }
  if (decisionReasonCodes.includes("REQUESTED_TECH_UNAVAILABLE")) {
    return `Recommend ${recommended.displayName}: the recorded requested technician is not currently eligible; this technician is available, qualified, appointment-safe, and earlier under the active fairness policy.`;
  }
  if (decisionReasonCodes.includes("UNVERIFIED_LEGACY_REQUEST_IGNORED")) {
    return `Recommend ${recommended.displayName}: legacy request provenance is unknown; this technician is available, qualified, appointment-safe, and earlier under the active fairness policy.`;
  }
  return `Recommend ${recommended.displayName}: available, qualified, appointment-safe, and earlier under the active fairness policy.`;
}

export function whyNotMeFromDecision(
  decision: TurnIqDecisionRecord,
  staffId: string,
): string | null {
  const trace = decision.candidates.find((candidate) => candidate.staffId === staffId);
  return trace ? explainWhyNotMe(trace) : null;
}
