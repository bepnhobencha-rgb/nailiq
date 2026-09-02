import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";
import {
  canCreateTurnIqDispute,
  canIssueTurnIqAssignmentCommand,
  canIssueTurnIqCorrectionCommand,
  canIssueTurnIqRefusalCommand,
  canIssueTurnIqRedoCommand,
  canIssueTurnIqShiftCommand,
  canIssueTurnIqSwapCommand,
  canResolveTurnIqTrustItem,
} from "@/shared/turniq/access";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import {
  turnIqAssignmentActionInputSchema,
  turnIqCorrectionActionInputSchema,
  turnIqCreateDisputeActionInputSchema,
  turnIqCreateSkipDisputeActionInputSchema,
  turnIqExceptionActionInputSchema,
  turnIqResolveDisputeActionInputSchema,
  turnIqRefusalActionInputSchema,
  turnIqRedoActionInputSchema,
  turnIqShiftActionInputSchema,
  turnIqSwapActionInputSchema,
  type TurnIqAssignmentActionInput,
  type TurnIqCommandActionResult,
  type TurnIqCorrectionActionInput,
  type TurnIqCreateDisputeActionInput,
  type TurnIqCreateSkipDisputeActionInput,
  type TurnIqExceptionActionInput,
  type TurnIqResolveDisputeActionInput,
  type TurnIqRefusalActionInput,
  type TurnIqRedoActionInput,
  type TurnIqServerActionErrorCode,
  type TurnIqShiftActionInput,
  type TurnIqSwapActionInput,
} from "@/shared/turniq/serverContracts";
import {
  turnIqStageAllowsOnlineMutation,
  type TurnIqRolloutStage,
} from "@/shared/turniq/rolloutStage";

export type TurnIqAuthorizedContext = {
  salonId: string;
  actorUserId: string;
  actorRole: SalonMemberRole;
  actorStaffId: string | null;
  featureEnabled: boolean;
  rolloutStage: TurnIqRolloutStage;
};

export type TurnIqRpcOutcome = {
  ok: boolean;
  code?: string;
  command_id?: string;
  replayed?: boolean;
  shift_session_id?: string;
  assignment_id?: string;
  state?: string;
  status?: string;
  state_version?: number;
  fairness_receipt_id?: string;
  exception_id?: string;
  aggregate_id?: string;
  dispute_id?: string;
  correction_id?: string;
  swap_id?: string;
  group_plan_id?: string;
  booking_group_id?: string;
  party_size?: number;
  fairness_receipts?: unknown;
};

export type TurnIqActionGateway = {
  resolveContext(slug: string): Promise<TurnIqAuthorizedContext | null>;
  loadAssignment(
    salonId: string,
    assignmentId: string,
  ): Promise<{ assignedStaffId: string | null } | null>;
  applyShift(args: {
    salonId: string;
    policyVersionId: string;
    staffId: string;
    commandType: string;
    reason: string | null;
    commandId: string;
    deviceId: string;
    localSequence: number;
    actorUserId: string;
    actorRole: SalonMemberRole;
    requestFingerprint: string;
    occurredAt: string;
  }): Promise<TurnIqRpcOutcome>;
  applyAssignment(args: {
    salonId: string;
    policyVersionId: string;
    assignmentId: string;
    commandType: string;
    assignedStaffId: string | null;
    overrideReason: string | null;
    commandId: string;
    deviceId: string;
    localSequence: number;
    actorUserId: string;
    actorRole: SalonMemberRole;
    requestFingerprint: string;
    occurredAt: string;
  }): Promise<TurnIqRpcOutcome>;
  applyRefusal(args: {
    salonId: string;
    policyVersionId: string;
    assignmentId: string;
    category: TurnIqRefusalActionInput["command"]["category"];
    reason: string;
    commandId: string;
    deviceId: string;
    localSequence: number;
    actorUserId: string;
    actorRole: SalonMemberRole;
    requestFingerprint: string;
    occurredAt: string;
  }): Promise<TurnIqRpcOutcome>;
  applyRedo(args: {
    salonId: string;
    policyVersionId: string;
    assignmentId: string;
    originalAssignmentId: string;
    category: TurnIqRedoActionInput["command"]["category"];
    note: string;
    commandId: string;
    deviceId: string;
    localSequence: number;
    actorUserId: string;
    actorRole: SalonMemberRole;
    requestFingerprint: string;
    occurredAt: string;
  }): Promise<TurnIqRpcOutcome>;
  applySwap(args: {
    salonId: string;
    policyVersionId: string;
    assignmentId: string | null;
    swapId: string | null;
    commandType: TurnIqSwapActionInput["type"];
    toStaffId: string | null;
    consentDecision: "accepted" | "rejected" | null;
    reason: string | null;
    commandId: string;
    deviceId: string;
    localSequence: number;
    actorUserId: string;
    actorRole: SalonMemberRole;
    requestFingerprint: string;
    occurredAt: string;
  }): Promise<TurnIqRpcOutcome>;
  applyCorrection(args: {
    salonId: string;
    policyVersionId: string;
    assignmentId: string;
    actualStaffId: string;
    category: TurnIqCorrectionActionInput["category"];
    reason: string;
    commandId: string;
    deviceId: string;
    localSequence: number;
    actorUserId: string;
    actorRole: SalonMemberRole;
    requestFingerprint: string;
    occurredAt: string;
  }): Promise<TurnIqRpcOutcome>;
  createDispute(args: {
    salonId: string;
    policyVersionId: string;
    fairnessReceiptId: string;
    category: string;
    reason: string;
    commandId: string;
    deviceId: string;
    localSequence: number;
    actorUserId: string;
    actorRole: SalonMemberRole;
    requestFingerprint: string;
    occurredAt: string;
  }): Promise<TurnIqRpcOutcome>;
  createSkipDispute(args: {
    salonId: string;
    policyVersionId: string;
    assignmentId: string;
    category: string;
    reason: string;
    commandId: string;
    deviceId: string;
    localSequence: number;
    actorUserId: string;
    actorRole: SalonMemberRole;
    requestFingerprint: string;
    occurredAt: string;
  }): Promise<TurnIqRpcOutcome>;
  resolveDispute(args: {
    salonId: string;
    policyVersionId: string;
    disputeId: string;
    resolutionStatus: "resolved" | "dismissed";
    reason: string;
    commandId: string;
    deviceId: string;
    localSequence: number;
    actorUserId: string;
    actorRole: SalonMemberRole;
    requestFingerprint: string;
    occurredAt: string;
  }): Promise<TurnIqRpcOutcome>;
  applyException(args: {
    salonId: string;
    policyVersionId: string;
    exceptionId: string;
    commandType: TurnIqExceptionActionInput["command"]["type"];
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

export class TurnIqGatewayError extends Error {
  constructor(readonly code: TurnIqServerActionErrorCode) {
    super(code);
    this.name = "TurnIqGatewayError";
  }
}

function failure(code: TurnIqServerActionErrorCode): TurnIqCommandActionResult {
  return { ok: false, code };
}

function stageFailure(context: TurnIqAuthorizedContext): TurnIqCommandActionResult | null {
  if (!context.featureEnabled) return failure("feature_disabled");
  if (!turnIqStageAllowsOnlineMutation(context.rolloutStage)) {
    return failure("rollout_stage_blocked");
  }
  return null;
}

function safeRpcResult(outcome: TurnIqRpcOutcome): TurnIqCommandActionResult {
  if (!outcome.ok) {
    if (
      outcome.code === "owner_confirmation_required" ||
      outcome.code === "policy_configuration_required"
    ) {
      return {
        ok: false,
        code: outcome.code,
        ...(outcome.exception_id ? { exceptionId: outcome.exception_id } : {}),
      };
    }
    return failure("stale_state");
  }
  const aggregateId =
    outcome.aggregate_id ??
    outcome.dispute_id ??
    outcome.exception_id ??
    outcome.correction_id ??
    outcome.swap_id ??
    outcome.assignment_id ??
    outcome.shift_session_id;
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
      fairnessReceiptId: outcome.fairness_receipt_id ?? null,
    },
  };
}

export async function createTurnIqDisputeCore(
  unsafeInput: TurnIqCreateDisputeActionInput,
  gateway: TurnIqActionGateway,
  now: () => string,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqCreateDisputeActionInputSchema.safeParse(unsafeInput);
  if (!parsed.success) return failure("invalid_input");
  try {
    const input = parsed.data;
    const context = await gateway.resolveContext(input.slug);
    if (!context) return failure("unauthorized");
    const blocked = stageFailure(context);
    if (blocked) return blocked;
    if (!canCreateTurnIqDispute(context.actorStaffId)) return failure("forbidden");
    const requestFingerprint = await fingerprint({
      kind: "turniq_dispute_command_v1",
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      policyVersionId: input.policyVersionId,
      fairnessReceiptId: input.fairnessReceiptId,
      command: input.command,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
    });
    return safeRpcResult(
      await gateway.createDispute({
        salonId: context.salonId,
        policyVersionId: input.policyVersionId,
        fairnessReceiptId: input.fairnessReceiptId,
        category: input.command.category,
        reason: input.command.reason,
        commandId: input.commandId,
        deviceId: input.deviceId,
        localSequence: input.localSequence,
        actorUserId: context.actorUserId,
        actorRole: context.actorRole,
        requestFingerprint,
        occurredAt: now(),
      }),
    );
  } catch (error) {
    return mapThrown(error);
  }
}

export async function createTurnIqSkipDisputeCore(
  unsafeInput: TurnIqCreateSkipDisputeActionInput,
  gateway: TurnIqActionGateway,
  now: () => string,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqCreateSkipDisputeActionInputSchema.safeParse(unsafeInput);
  if (!parsed.success) return failure("invalid_input");
  try {
    const input = parsed.data;
    const context = await gateway.resolveContext(input.slug);
    if (!context) return failure("unauthorized");
    const blocked = stageFailure(context);
    if (blocked) return blocked;
    if (!canCreateTurnIqDispute(context.actorStaffId)) return failure("forbidden");
    const requestFingerprint = await fingerprint({
      kind: "turniq_skip_dispute_command_v1",
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      actorStaffId: context.actorStaffId,
      policyVersionId: input.policyVersionId,
      assignmentId: input.assignmentId,
      command: input.command,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
    });
    return safeRpcResult(
      await gateway.createSkipDispute({
        salonId: context.salonId,
        policyVersionId: input.policyVersionId,
        assignmentId: input.assignmentId,
        category: input.command.category,
        reason: input.command.reason,
        commandId: input.commandId,
        deviceId: input.deviceId,
        localSequence: input.localSequence,
        actorUserId: context.actorUserId,
        actorRole: context.actorRole,
        requestFingerprint,
        occurredAt: now(),
      }),
    );
  } catch (error) {
    return mapThrown(error);
  }
}

export async function resolveTurnIqDisputeCore(
  unsafeInput: TurnIqResolveDisputeActionInput,
  gateway: TurnIqActionGateway,
  now: () => string,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqResolveDisputeActionInputSchema.safeParse(unsafeInput);
  if (!parsed.success) return failure("invalid_input");
  try {
    const input = parsed.data;
    const context = await gateway.resolveContext(input.slug);
    if (!context) return failure("unauthorized");
    const blocked = stageFailure(context);
    if (blocked) return blocked;
    if (!canResolveTurnIqTrustItem(context.actorRole)) return failure("forbidden");
    const requestFingerprint = await fingerprint({
      kind: "turniq_resolve_dispute_command_v1",
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      policyVersionId: input.policyVersionId,
      disputeId: input.disputeId,
      command: input.command,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
    });
    return safeRpcResult(
      await gateway.resolveDispute({
        salonId: context.salonId,
        policyVersionId: input.policyVersionId,
        disputeId: input.disputeId,
        resolutionStatus: input.command.resolution,
        reason: input.command.reason,
        commandId: input.commandId,
        deviceId: input.deviceId,
        localSequence: input.localSequence,
        actorUserId: context.actorUserId,
        actorRole: context.actorRole,
        requestFingerprint,
        occurredAt: now(),
      }),
    );
  } catch (error) {
    return mapThrown(error);
  }
}

export async function applyTurnIqExceptionCommandCore(
  unsafeInput: TurnIqExceptionActionInput,
  gateway: TurnIqActionGateway,
  now: () => string,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqExceptionActionInputSchema.safeParse(unsafeInput);
  if (!parsed.success) return failure("invalid_input");
  try {
    const input = parsed.data;
    const context = await gateway.resolveContext(input.slug);
    if (!context) return failure("unauthorized");
    const blocked = stageFailure(context);
    if (blocked) return blocked;
    if (!canResolveTurnIqTrustItem(context.actorRole)) return failure("forbidden");
    const requestFingerprint = await fingerprint({
      kind: "turniq_exception_command_v1",
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      policyVersionId: input.policyVersionId,
      exceptionId: input.exceptionId,
      command: input.command,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
    });
    return safeRpcResult(
      await gateway.applyException({
        salonId: context.salonId,
        policyVersionId: input.policyVersionId,
        exceptionId: input.exceptionId,
        commandType: input.command.type,
        reason:
          input.command.type === "acknowledge_exception"
            ? null
            : input.command.reason,
        commandId: input.commandId,
        deviceId: input.deviceId,
        localSequence: input.localSequence,
        actorUserId: context.actorUserId,
        actorRole: context.actorRole,
        requestFingerprint,
        occurredAt: now(),
      }),
    );
  } catch (error) {
    return mapThrown(error);
  }
}

async function fingerprint(material: unknown): Promise<string> {
  return sha256TurnIqHex(canonicalTurnIqJson(material));
}

function mapThrown(error: unknown): TurnIqCommandActionResult {
  if (error instanceof TurnIqGatewayError) return failure(error.code);
  return failure("server_error");
}

export async function applyTurnIqShiftCommandCore(
  unsafeInput: TurnIqShiftActionInput,
  gateway: TurnIqActionGateway,
  now: () => string,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqShiftActionInputSchema.safeParse(unsafeInput);
  if (!parsed.success) return failure("invalid_input");
  try {
    const input = parsed.data;
    const context = await gateway.resolveContext(input.slug);
    if (!context) return failure("unauthorized");
    const blocked = stageFailure(context);
    if (blocked) return blocked;
    if (
      !canIssueTurnIqShiftCommand(
        context.actorRole,
        context.actorStaffId,
        input.staffId,
      )
    ) {
      return failure("forbidden");
    }
    const requestFingerprint = await fingerprint({
      kind: "turniq_shift_command_v1",
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      policyVersionId: input.policyVersionId,
      staffId: input.staffId,
      command: input.command,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
    });
    const outcome = await gateway.applyShift({
      salonId: context.salonId,
      policyVersionId: input.policyVersionId,
      staffId: input.staffId,
      commandType: input.command.type,
      reason:
        input.command.type === "break" || input.command.type === "hold"
          ? input.command.reason
          : null,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      requestFingerprint,
      occurredAt: now(),
    });
    return safeRpcResult(outcome);
  } catch (error) {
    return mapThrown(error);
  }
}

export async function applyTurnIqAssignmentCommandCore(
  unsafeInput: TurnIqAssignmentActionInput,
  gateway: TurnIqActionGateway,
  now: () => string,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqAssignmentActionInputSchema.safeParse(unsafeInput);
  if (!parsed.success) return failure("invalid_input");
  try {
    const input = parsed.data;
    const context = await gateway.resolveContext(input.slug);
    if (!context) return failure("unauthorized");
    const blocked = stageFailure(context);
    if (blocked) return blocked;
    const assignment = await gateway.loadAssignment(
      context.salonId,
      input.assignmentId,
    );
    if (!assignment) return failure("not_found");
    const assignedStaffId =
      input.command.type === "confirm" || input.command.type === "override"
        ? input.command.assignedStaffId
        : assignment.assignedStaffId;
    if (
      !canIssueTurnIqAssignmentCommand({
        role: context.actorRole,
        actorStaffId: context.actorStaffId,
        assignedStaffId,
        commandType: input.command.type,
      })
    ) {
      return failure("forbidden");
    }
    const requestFingerprint = await fingerprint({
      kind: "turniq_assignment_command_v1",
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      policyVersionId: input.policyVersionId,
      assignmentId: input.assignmentId,
      command: input.command,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
    });
    const outcome = await gateway.applyAssignment({
      salonId: context.salonId,
      policyVersionId: input.policyVersionId,
      assignmentId: input.assignmentId,
      commandType: input.command.type,
      assignedStaffId,
      overrideReason:
        input.command.type === "override" ? input.command.reason : null,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      requestFingerprint,
      occurredAt: now(),
    });
    return safeRpcResult(outcome);
  } catch (error) {
    return mapThrown(error);
  }
}

export async function applyTurnIqRefusalCommandCore(
  unsafeInput: TurnIqRefusalActionInput,
  gateway: TurnIqActionGateway,
  now: () => string,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqRefusalActionInputSchema.safeParse(unsafeInput);
  if (!parsed.success) return failure("invalid_input");
  try {
    const input = parsed.data;
    const context = await gateway.resolveContext(input.slug);
    if (!context) return failure("unauthorized");
    const blocked = stageFailure(context);
    if (blocked) return blocked;
    if (!canIssueTurnIqRefusalCommand(context.actorRole)) {
      return failure("forbidden");
    }
    const requestFingerprint = await fingerprint({
      kind: "turniq_refusal_command_v1",
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      policyVersionId: input.policyVersionId,
      assignmentId: input.assignmentId,
      command: input.command,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
    });
    return safeRpcResult(
      await gateway.applyRefusal({
        salonId: context.salonId,
        policyVersionId: input.policyVersionId,
        assignmentId: input.assignmentId,
        category: input.command.category,
        reason: input.command.reason,
        commandId: input.commandId,
        deviceId: input.deviceId,
        localSequence: input.localSequence,
        actorUserId: context.actorUserId,
        actorRole: context.actorRole,
        requestFingerprint,
        occurredAt: now(),
      }),
    );
  } catch (error) {
    return mapThrown(error);
  }
}

export async function applyTurnIqRedoCommandCore(
  unsafeInput: TurnIqRedoActionInput,
  gateway: TurnIqActionGateway,
  now: () => string,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqRedoActionInputSchema.safeParse(unsafeInput);
  if (!parsed.success) return failure("invalid_input");
  try {
    const input = parsed.data;
    const context = await gateway.resolveContext(input.slug);
    if (!context) return failure("unauthorized");
    const blocked = stageFailure(context);
    if (blocked) return blocked;
    if (!canIssueTurnIqRedoCommand(context.actorRole)) {
      return failure("forbidden");
    }
    const requestFingerprint = await fingerprint({
      kind: "turniq_redo_command_v1",
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      policyVersionId: input.policyVersionId,
      assignmentId: input.assignmentId,
      command: input.command,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
    });
    return safeRpcResult(
      await gateway.applyRedo({
        salonId: context.salonId,
        policyVersionId: input.policyVersionId,
        assignmentId: input.assignmentId,
        originalAssignmentId: input.command.originalAssignmentId,
        category: input.command.category,
        note: input.command.note,
        commandId: input.commandId,
        deviceId: input.deviceId,
        localSequence: input.localSequence,
        actorUserId: context.actorUserId,
        actorRole: context.actorRole,
        requestFingerprint,
        occurredAt: now(),
      }),
    );
  } catch (error) {
    return mapThrown(error);
  }
}

export async function applyTurnIqSwapCommandCore(
  unsafeInput: TurnIqSwapActionInput,
  gateway: TurnIqActionGateway,
  now: () => string,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqSwapActionInputSchema.safeParse(unsafeInput);
  if (!parsed.success) return failure("invalid_input");
  try {
    const input = parsed.data;
    const context = await gateway.resolveContext(input.slug);
    if (!context) return failure("unauthorized");
    const blocked = stageFailure(context);
    if (blocked) return blocked;
    if (!canIssueTurnIqSwapCommand({
      role: context.actorRole,
      actorStaffId: context.actorStaffId,
      commandType: input.type,
    })) return failure("forbidden");
    const requestFingerprint = await fingerprint({
      kind: "turniq_swap_command_v1",
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      policyVersionId: input.policyVersionId,
      command: input,
    });
    return safeRpcResult(await gateway.applySwap({
      salonId: context.salonId,
      policyVersionId: input.policyVersionId,
      assignmentId: input.type === "request_swap" ? input.assignmentId : null,
      swapId: input.type === "request_swap" ? null : input.swapId,
      commandType: input.type,
      toStaffId: input.type === "request_swap" ? input.toStaffId : null,
      consentDecision: input.type === "consent_swap" ? input.decision : null,
      reason: input.type === "request_swap" ? input.reason : null,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      requestFingerprint,
      occurredAt: now(),
    }));
  } catch (error) {
    return mapThrown(error);
  }
}

export async function applyTurnIqCorrectionCommandCore(
  unsafeInput: TurnIqCorrectionActionInput,
  gateway: TurnIqActionGateway,
  now: () => string,
): Promise<TurnIqCommandActionResult> {
  const parsed = turnIqCorrectionActionInputSchema.safeParse(unsafeInput);
  if (!parsed.success) return failure("invalid_input");
  try {
    const input = parsed.data;
    const context = await gateway.resolveContext(input.slug);
    if (!context) return failure("unauthorized");
    const blocked = stageFailure(context);
    if (blocked) return blocked;
    if (!canIssueTurnIqCorrectionCommand(context.actorRole)) {
      return failure("forbidden");
    }
    const requestFingerprint = await fingerprint({
      kind: "turniq_assignment_correction_v1",
      salonId: context.salonId,
      actorUserId: context.actorUserId,
      policyVersionId: input.policyVersionId,
      assignmentId: input.assignmentId,
      actualStaffId: input.actualStaffId,
      category: input.category,
      reason: input.reason,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
    });
    return safeRpcResult(await gateway.applyCorrection({
      salonId: context.salonId,
      policyVersionId: input.policyVersionId,
      assignmentId: input.assignmentId,
      actualStaffId: input.actualStaffId,
      category: input.category,
      reason: input.reason,
      commandId: input.commandId,
      deviceId: input.deviceId,
      localSequence: input.localSequence,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      requestFingerprint,
      occurredAt: now(),
    }));
  } catch (error) {
    return mapThrown(error);
  }
}
