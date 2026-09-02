import {
  canonicalTurnIqJson,
  sha256TurnIqHex,
} from "@/shared/turniq/fingerprint";
import { requestedTechTrustLabel } from "@/shared/turniq/contracts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

export const TURNIQ_CUSTOMER_CHECKIN_REASON_CODES = [
  "CHECKIN_SHADOW_RECEIVED",
  "BOOKED_CAPABILITY_MATCH_REQUIRED",
  "WALKIN_IDENTITY_MATCH_REQUIRED",
  "SINGLE_ENGINE_CANDIDATE",
  "GROUP_OPTIMIZER_REQUIRED",
  "REQUESTED_TECH_CUSTOMER_CONFIRMED",
] as const;

export type TurnIqCustomerCheckInReasonCode =
  (typeof TURNIQ_CUSTOMER_CHECKIN_REASON_CODES)[number];

export type TurnIqCustomerCheckInInput = {
  commandId: string;
  channel: "qr" | "kiosk";
  visitKind: "booked" | "walkin";
  serviceId: string;
  partySize: number;
  submittedAt: string;
  actorSessionFingerprint: string;
  requestedTechnician: {
    staffId: string;
    explicitlyConfirmed: true;
  } | null;
};

export type TurnIqCustomerCheckInReceipt = {
  version: 1;
  commandId: string;
  intakeFingerprint: string;
  shadowOnly: true;
  channel: "qr" | "kiosk";
  visitKind: "booked" | "walkin";
  serviceId: string;
  partySize: number;
  submittedAt: string;
  nextRoute:
    | "single_engine_candidate"
    | "group_optimizer_required"
    | "requested_tech_validation"
    | "identity_match_required";
  requestedTechnician: {
    staffId: string;
    source: "customer_selected";
    trustLabel: "customer_confirmed";
    actorRef: string;
    recordedAt: string;
  } | null;
  reasonCodes: readonly TurnIqCustomerCheckInReasonCode[];
  message: { en: string; vi: string };
};

export class TurnIqCustomerCheckInError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TurnIqCustomerCheckInError";
  }
}

function requireUuid(value: string, code: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_RE.test(normalized)) throw new TurnIqCustomerCheckInError(code);
  return normalized;
}

function requireIso(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TurnIqCustomerCheckInError("turniq_checkin_invalid_submitted_at");
  }
  return new Date(parsed).toISOString();
}

/**
 * Creates a PII-free, deterministic shadow receipt for QR/kiosk intake. This
 * function never creates a booking or assignment. A future server boundary
 * must re-load salon/service/staff truth and atomically deduplicate commandId.
 */
export async function createTurnIqCustomerCheckInReceipt(
  input: TurnIqCustomerCheckInInput,
): Promise<TurnIqCustomerCheckInReceipt> {
  if (input.channel !== "qr" && input.channel !== "kiosk") {
    throw new TurnIqCustomerCheckInError("turniq_checkin_invalid_channel");
  }
  if (input.visitKind !== "booked" && input.visitKind !== "walkin") {
    throw new TurnIqCustomerCheckInError("turniq_checkin_invalid_visit_kind");
  }
  if (
    input.requestedTechnician &&
    input.requestedTechnician.explicitlyConfirmed !== true
  ) {
    throw new TurnIqCustomerCheckInError(
      "turniq_checkin_requested_tech_not_confirmed",
    );
  }
  const commandId = requireUuid(input.commandId, "turniq_checkin_invalid_command_id");
  const serviceId = requireUuid(input.serviceId, "turniq_checkin_invalid_service_id");
  const submittedAt = requireIso(input.submittedAt);
  if (!Number.isSafeInteger(input.partySize) || input.partySize < 1 || input.partySize > 12) {
    throw new TurnIqCustomerCheckInError("turniq_checkin_invalid_party_size");
  }
  if (!SHA256_RE.test(input.actorSessionFingerprint)) {
    throw new TurnIqCustomerCheckInError("turniq_checkin_invalid_actor_session");
  }
  const requestedStaffId = input.requestedTechnician
    ? requireUuid(
        input.requestedTechnician.staffId,
        "turniq_checkin_invalid_requested_staff",
      )
    : null;
  const actorRef = await sha256TurnIqHex(
    `turniq-checkin-actor-v1:${input.actorSessionFingerprint}`,
  );
  const requestedTechnician = requestedStaffId
    ? {
        staffId: requestedStaffId,
        source: "customer_selected" as const,
        trustLabel: requestedTechTrustLabel("customer_selected") as "customer_confirmed",
        actorRef,
        recordedAt: submittedAt,
      }
    : null;
  const reasonCodes: TurnIqCustomerCheckInReasonCode[] = [
    "CHECKIN_SHADOW_RECEIVED",
    input.visitKind === "booked"
      ? "BOOKED_CAPABILITY_MATCH_REQUIRED"
      : "WALKIN_IDENTITY_MATCH_REQUIRED",
  ];
  if (requestedTechnician) {
    reasonCodes.push("REQUESTED_TECH_CUSTOMER_CONFIRMED");
  }
  let nextRoute: TurnIqCustomerCheckInReceipt["nextRoute"];
  if (input.visitKind === "walkin") {
    nextRoute = "identity_match_required";
  } else if (requestedTechnician) {
    nextRoute = "requested_tech_validation";
  } else if (input.partySize > 1) {
    nextRoute = "group_optimizer_required";
    reasonCodes.push("GROUP_OPTIMIZER_REQUIRED");
  } else {
    nextRoute = "single_engine_candidate";
    reasonCodes.push("SINGLE_ENGINE_CANDIDATE");
  }
  const intakeFingerprint = await sha256TurnIqHex(canonicalTurnIqJson({
    version: 1,
    commandId,
    channel: input.channel,
    visitKind: input.visitKind,
    serviceId,
    partySize: input.partySize,
    submittedAt,
    actorRef,
    requestedTechnician,
    nextRoute,
  }));

  return {
    version: 1,
    commandId,
    intakeFingerprint,
    shadowOnly: true,
    channel: input.channel,
    visitKind: input.visitKind,
    serviceId,
    partySize: input.partySize,
    submittedAt,
    nextRoute,
    requestedTechnician,
    reasonCodes,
    message: {
      en: "Check-in received for a safe availability review. No appointment has changed yet.",
      vi: "Đã nhận check-in để kiểm tra chỗ an toàn. Chưa có lịch hẹn nào bị thay đổi.",
    },
  };
}
