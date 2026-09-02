import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  createTurnIqCustomerCheckInReceipt,
  TurnIqCustomerCheckInError,
  type TurnIqCustomerCheckInInput,
  type TurnIqCustomerCheckInReceipt,
} from "@/shared/turniq/customerCheckIn";
import { sha256TurnIqHex } from "@/shared/turniq/fingerprint";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RpcRow = Record<string, unknown>;

export type TurnIqCustomerCheckInServerCode =
  | "invalid_request"
  | "invalid_capability"
  | "capability_unavailable"
  | "capability_mismatch"
  | "feature_disabled"
  | "service_mismatch"
  | "booking_mismatch"
  | "requested_staff_mismatch"
  | "idempotency_conflict"
  | "temporarily_unavailable";

export type TurnIqCustomerCheckInServerResult =
  | {
      ok: true;
      replayed: boolean;
      status: "shadow_received";
      nextRoute: TurnIqCustomerCheckInReceipt["nextRoute"];
      intakeFingerprint: string;
      message: TurnIqCustomerCheckInReceipt["message"];
    }
  | { ok: false; code: TurnIqCustomerCheckInServerCode };

export type TurnIqCustomerCheckInCapabilityInput = {
  salonId: string;
  bookingId: string | null;
  /** Null only for a reusable kiosk walk-in capability; the submitted active
   * service is still mandatory and revalidated by the record RPC. */
  serviceId: string | null;
  channel: "qr" | "kiosk";
  visitKind: "booked" | "walkin";
  expiresAt: string;
  maxUses: number;
  actorUserId: string;
};

export type TurnIqCustomerCheckInCapabilityResult =
  | {
      ok: true;
      capabilityId: string;
      token: string;
      expiresAt: string;
      maxUses: number;
    }
  | { ok: false; code: string };

function cleanCode(value: unknown): TurnIqCustomerCheckInServerCode {
  switch (value) {
    case "invalid_capability":
    case "capability_unavailable":
    case "capability_mismatch":
    case "feature_disabled":
    case "service_mismatch":
    case "booking_mismatch":
    case "requested_staff_mismatch":
    case "idempotency_conflict":
      return value;
    default:
      return "temporarily_unavailable";
  }
}

function isNextRoute(
  value: unknown,
): value is TurnIqCustomerCheckInReceipt["nextRoute"] {
  return value === "single_engine_candidate"
    || value === "group_optimizer_required"
    || value === "requested_tech_validation"
    || value === "identity_match_required";
}

/**
 * Mints a short-lived opaque bearer. Only its SHA-256 hash is stored. The SQL
 * boundary re-checks actor membership, salon feature state and booked subject.
 * This helper does not expose a public issuance route.
 */
export async function issueTurnIqCustomerCheckInCapability(
  input: TurnIqCustomerCheckInCapabilityInput,
): Promise<TurnIqCustomerCheckInCapabilityResult> {
  const token = globalThis.crypto.randomUUID();
  const tokenHash = await sha256TurnIqHex(
    `turniq-customer-checkin-capability-v1:${token}`,
  );
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "issue_turniq_customer_checkin_capability_v1" as never,
      {
        p_salon_id: input.salonId,
        p_booking_id: input.bookingId,
        p_service_id: input.serviceId,
        p_channel: input.channel,
        p_visit_kind: input.visitKind,
        p_token_hash: tokenHash,
        p_expires_at: input.expiresAt,
        p_max_uses: input.maxUses,
        p_actor_user_id: input.actorUserId,
      } as never,
    );
    if (error || !data || typeof data !== "object") {
      return { ok: false, code: "temporarily_unavailable" };
    }
    const row = data as RpcRow;
    if (row.ok !== true) {
      return {
        ok: false,
        code: typeof row.code === "string" ? row.code : "temporarily_unavailable",
      };
    }
    if (
      typeof row.capability_id !== "string"
      || !UUID_RE.test(row.capability_id)
      || typeof row.expires_at !== "string"
      || !Number.isSafeInteger(row.max_uses)
    ) {
      return { ok: false, code: "temporarily_unavailable" };
    }
    return {
      ok: true,
      capabilityId: row.capability_id,
      token,
      expiresAt: row.expires_at,
      maxUses: Number(row.max_uses),
    };
  } catch {
    return { ok: false, code: "temporarily_unavailable" };
  }
}

export type TurnIqCustomerCheckInRevokeResult =
  | { ok: true; capabilityId: string; revokedAt: string; replayed: boolean }
  | { ok: false; code: string };

/** Irreversibly revokes one same-salon QR/kiosk capability. The SQL boundary
 * re-checks the actor membership and returns the existing result on retry. */
export async function revokeTurnIqCustomerCheckInCapability(input: {
  salonId: string;
  capabilityId: string;
  actorUserId: string;
}): Promise<TurnIqCustomerCheckInRevokeResult> {
  if (
    !UUID_RE.test(input.salonId)
    || !UUID_RE.test(input.capabilityId)
    || !UUID_RE.test(input.actorUserId)
  ) return { ok: false, code: "invalid_request" };

  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "revoke_turniq_customer_checkin_capability_v1" as never,
      {
        p_salon_id: input.salonId,
        p_capability_id: input.capabilityId,
        p_actor_user_id: input.actorUserId,
      } as never,
    );
    if (error || !data || typeof data !== "object") {
      return { ok: false, code: "temporarily_unavailable" };
    }
    const row = data as RpcRow;
    if (row.ok !== true) {
      return {
        ok: false,
        code: typeof row.code === "string" ? row.code : "temporarily_unavailable",
      };
    }
    if (
      typeof row.capability_id !== "string"
      || !UUID_RE.test(row.capability_id)
      || typeof row.revoked_at !== "string"
    ) return { ok: false, code: "temporarily_unavailable" };
    return {
      ok: true,
      capabilityId: row.capability_id,
      revokedAt: row.revoked_at,
      replayed: row.replayed === true,
    };
  } catch {
    return { ok: false, code: "temporarily_unavailable" };
  }
}

/**
 * Records a capability-bound, append-only shadow intake. The authoritative SQL
 * function validates tenant/service/booking/staff truth and exact-once command
 * identity. It has no booking, assignment, provider or notification side effect.
 */
export async function recordTurnIqCustomerCheckInShadow(
  capabilityToken: string,
  input: TurnIqCustomerCheckInInput,
): Promise<TurnIqCustomerCheckInServerResult> {
  const token = capabilityToken.trim().toLowerCase();
  if (!UUID_RE.test(token)) return { ok: false, code: "invalid_capability" };

  let receipt: TurnIqCustomerCheckInReceipt;
  try {
    receipt = await createTurnIqCustomerCheckInReceipt(input);
  } catch (error) {
    if (error instanceof TurnIqCustomerCheckInError) {
      return { ok: false, code: "invalid_request" };
    }
    return { ok: false, code: "temporarily_unavailable" };
  }

  const tokenHash = await sha256TurnIqHex(
    `turniq-customer-checkin-capability-v1:${token}`,
  );
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "record_turniq_customer_checkin_shadow_v1" as never,
      {
        p_capability_token_hash: tokenHash,
        p_channel: receipt.channel,
        p_visit_kind: receipt.visitKind,
        p_command_id: receipt.commandId,
        p_service_id: receipt.serviceId,
        p_party_size: receipt.partySize,
        p_submitted_at: receipt.submittedAt,
        p_actor_ref: receipt.requestedTechnician?.actorRef
          ?? await sha256TurnIqHex(
            `turniq-checkin-actor-v1:${input.actorSessionFingerprint}`,
          ),
        p_requested_staff_id: receipt.requestedTechnician?.staffId ?? null,
        p_intake_fingerprint: receipt.intakeFingerprint,
      } as never,
    );
    if (error || !data || typeof data !== "object") {
      return { ok: false, code: "temporarily_unavailable" };
    }
    const row = data as RpcRow;
    if (row.ok !== true) return { ok: false, code: cleanCode(row.code) };
    if (
      row.status !== "shadow_received"
      || !isNextRoute(row.next_route)
      || row.next_route !== receipt.nextRoute
      || row.intake_fingerprint !== receipt.intakeFingerprint
    ) {
      return { ok: false, code: "temporarily_unavailable" };
    }
    return {
      ok: true,
      replayed: row.replayed === true,
      status: "shadow_received",
      nextRoute: row.next_route,
      intakeFingerprint: receipt.intakeFingerprint,
      message: receipt.message,
    };
  } catch {
    return { ok: false, code: "temporarily_unavailable" };
  }
}
