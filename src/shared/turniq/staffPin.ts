import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";
import type {
  TurnIqAuthorizedContext,
  TurnIqRpcOutcome,
} from "@/shared/turniq/actionCore";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import {
  turnIqConfigureStaffPinInputSchema,
  turnIqPinShiftActionInputSchema,
  type TurnIqCommandActionResult,
  type TurnIqConfigureStaffPinActionResult,
  type TurnIqConfigureStaffPinInput,
  type TurnIqPinShiftActionInput,
  type TurnIqServerActionErrorCode,
} from "@/shared/turniq/serverContracts";
import { turnIqStageAllowsOnlineMutation } from "@/shared/turniq/rolloutStage";

type ConfigurePinOutcome = {
  ok: boolean;
  code?: string;
  command_id?: string;
  replayed?: boolean;
  staff_id?: string;
  pin_version?: number;
  configured_at?: string;
};

export type TurnIqStaffPinGateway = {
  resolveContext(slug: string): Promise<TurnIqAuthorizedContext | null>;
  configurePin(args: {
    salonId: string;
    staffId: string;
    pin: string;
    commandId: string;
    actorUserId: string;
    actorRole: SalonMemberRole;
    occurredAt: string;
  }): Promise<ConfigurePinOutcome>;
  applyPinShift(args: {
    salonId: string;
    policyVersionId: string;
    staffId: string;
    pin: string;
    commandType: TurnIqPinShiftActionInput["command"]["type"];
    reason: string | null;
    commandId: string;
    deviceId: string;
    localSequence: number;
    actorUserId: string;
    actorRole: SalonMemberRole;
    requestFingerprint: string;
    occurredAt: string;
  }): Promise<TurnIqRpcOutcome>;
};

function failure(code: TurnIqServerActionErrorCode): TurnIqCommandActionResult {
  return { ok: false, code };
}

function mapPinFailure(code: string | undefined): TurnIqServerActionErrorCode {
  if (code === "invalid_pin" || code === "pin_locked") return code;
  if (code === "forbidden") return "forbidden";
  if (code === "feature_disabled") return "feature_disabled";
  if (code === "rollout_stage_blocked") return "rollout_stage_blocked";
  if (code === "stale_state") return "stale_state";
  return "server_error";
}

function safeShiftResult(outcome: TurnIqRpcOutcome): TurnIqCommandActionResult {
  if (!outcome.ok) return failure(mapPinFailure(outcome.code));
  const aggregateId = outcome.aggregate_id ?? outcome.shift_session_id;
  const status = outcome.status ?? outcome.state;
  if (
    !outcome.command_id ||
    !aggregateId ||
    !status ||
    !Number.isSafeInteger(outcome.state_version)
  ) {
    return failure("server_error");
  }
  return {
    ok: true,
    result: {
      commandId: outcome.command_id,
      replayed: outcome.replayed === true,
      aggregateId,
      status,
      stateVersion: outcome.state_version as number,
      fairnessReceiptId: null,
    },
  };
}

function mayConfigurePin(role: SalonMemberRole): boolean {
  return role === "owner" || role === "admin";
}

function mayUseSharedPin(
  context: TurnIqAuthorizedContext,
  targetStaffId: string,
): boolean {
  return (
    context.actorRole !== "nail_tech" ||
    (context.actorStaffId !== null && context.actorStaffId === targetStaffId)
  );
}

/**
 * Configures or rotates a staff PIN. The PIN is intentionally not used in an
 * application fingerprint: a four-digit secret must not become an offline
 * brute-force oracle in logs or durable receipts.
 */
export async function configureTurnIqStaffPinCore(
  unsafeInput: TurnIqConfigureStaffPinInput,
  gateway: TurnIqStaffPinGateway,
  now: () => string,
): Promise<TurnIqConfigureStaffPinActionResult> {
  const parsed = turnIqConfigureStaffPinInputSchema.safeParse(unsafeInput);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  try {
    const input = parsed.data;
    const context = await gateway.resolveContext(input.slug);
    if (!context) return { ok: false, code: "unauthorized" };
    if (!context.featureEnabled) return { ok: false, code: "feature_disabled" };
    if (!mayConfigurePin(context.actorRole)) {
      return { ok: false, code: "forbidden" };
    }
    const outcome = await gateway.configurePin({
      salonId: context.salonId,
      staffId: input.staffId,
      pin: input.pin,
      commandId: input.commandId,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      occurredAt: now(),
    });
    if (!outcome.ok) return { ok: false, code: mapPinFailure(outcome.code) };
    if (
      !outcome.command_id ||
      !outcome.staff_id ||
      !Number.isSafeInteger(outcome.pin_version) ||
      !outcome.configured_at
    ) {
      return { ok: false, code: "server_error" };
    }
    return {
      ok: true,
      result: {
        commandId: outcome.command_id,
        replayed: outcome.replayed === true,
        staffId: outcome.staff_id,
        pinVersion: outcome.pin_version as number,
        configuredAt: outcome.configured_at,
      },
    };
  } catch {
    return { ok: false, code: "server_error" };
  }
}

/**
 * Applies a technician-authenticated shift action from a shared salon device.
 * The server session remains the accountable device actor; the durable PIN
 * receipt separately records which technician proved possession of the PIN.
 */
export async function applyTurnIqPinShiftCommandCore(
  unsafeInput: TurnIqPinShiftActionInput,
  gateway: TurnIqStaffPinGateway,
  now: () => string,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqPinShiftActionInputSchema.safeParse(unsafeInput);
  if (!parsed.success) return failure("invalid_input");
  try {
    const input = parsed.data;
    const context = await gateway.resolveContext(input.slug);
    if (!context) return failure("unauthorized");
    if (!context.featureEnabled) return failure("feature_disabled");
    if (!turnIqStageAllowsOnlineMutation(context.rolloutStage)) {
      return failure("rollout_stage_blocked");
    }
    if (!mayUseSharedPin(context, input.staffId)) return failure("forbidden");

    const requestFingerprint = await sha256TurnIqHex(
      canonicalTurnIqJson({
        kind: "turniq_staff_pin_shift_command_v1",
        authenticationMethod: "staff_pin",
        salonId: context.salonId,
        actorUserId: context.actorUserId,
        policyVersionId: input.policyVersionId,
        staffId: input.staffId,
        command: input.command,
        commandId: input.commandId,
        deviceId: input.deviceId,
        localSequence: input.localSequence,
      }),
    );
    return safeShiftResult(
      await gateway.applyPinShift({
        salonId: context.salonId,
        policyVersionId: input.policyVersionId,
        staffId: input.staffId,
        pin: input.pin,
        commandType: input.command.type,
        reason: input.command.type === "break" ? input.command.reason : null,
        commandId: input.commandId,
        deviceId: input.deviceId,
        localSequence: input.localSequence,
        actorUserId: context.actorUserId,
        actorRole: context.actorRole,
        requestFingerprint,
        occurredAt: now(),
      }),
    );
  } catch {
    return failure("server_error");
  }
}
