import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  fingerprintTurnIqOfflineCommand,
  TURNIQ_OFFLINE_CONFLICT_CODES,
  type TurnIqOfflineCommand,
  type TurnIqOfflineConflictCode,
  type TurnIqOfflineDeviceActionResult,
  type TurnIqOfflineLease,
  type TurnIqOfflineReplayActionResult,
  type TurnIqOfflineReconcileActionResult,
} from "@/shared/turniq/offlineContracts";

const offlineConflictCodes = new Set<string>(TURNIQ_OFFLINE_CONFLICT_CODES);

function offlineConflictCode(value: string | null): TurnIqOfflineConflictCode {
  return value && offlineConflictCodes.has(value)
    ? value as TurnIqOfflineConflictCode
    : "domain_conflict";
}
import { resolveTurnIqContext } from "@/shared/turniq/serverDal";
import { turnIqStageAllowsOfflineMutation } from "@/shared/turniq/rolloutStage";

type RpcJson = Record<string, unknown> | null;

function stringValue(row: RpcJson, key: string): string | null {
  return typeof row?.[key] === "string" ? String(row[key]) : null;
}

function numberValue(row: RpcJson, key: string): number | null {
  const value = row?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function leaseFromRpc(
  salonId: string,
  actorUserId: string,
  row: RpcJson,
): TurnIqOfflineLease | null {
  const deviceId = stringValue(row, "device_id");
  const generation = numberValue(row, "device_generation");
  const stateVersion = numberValue(row, "state_version");
  const lastAckedSequence = numberValue(row, "last_acked_sequence");
  const status = stringValue(row, "status");
  if (
    !deviceId || generation === null || stateVersion === null ||
    lastAckedSequence === null ||
    (status !== "primary" && status !== "revoked")
  ) return null;
  return {
    salonId,
    deviceId,
    actorUserId,
    generation,
    stateVersion,
    lastAckedSequence,
    status,
  };
}

async function contextFor(slug: string) {
  const context = await resolveTurnIqContext(slug);
  if (!context) return { ok: false as const, code: "unauthorized" as const };
  if (!context.featureEnabled) return { ok: false as const, code: "feature_disabled" as const };
  if (!turnIqStageAllowsOfflineMutation(context.rolloutStage)) {
    return { ok: false as const, code: "rollout_stage_blocked" as const };
  }
  return { ok: true as const, context };
}

export async function inspectTurnIqOfflineDevice(
  slug: string,
  deviceId: string,
): Promise<TurnIqOfflineDeviceActionResult> {
  const authorized = await contextFor(slug);
  if (!authorized.ok) return authorized;
  const { data, error } = await createServiceRoleClient().rpc(
    "inspect_turniq_offline_device_v1" as never,
    { p_salon_id: authorized.context.salonId, p_device_id: deviceId } as never,
  );
  if (error) return { ok: false, code: "server_error" };
  const lease = leaseFromRpc(
    authorized.context.salonId,
    authorized.context.actorUserId,
    data as unknown as RpcJson,
  );
  return lease ? { ok: true, lease } : { ok: false, code: "not_found" };
}

export async function pairTurnIqOfflineDevice(input: {
  slug: string;
  deviceId: string;
  label: string;
}): Promise<TurnIqOfflineDeviceActionResult> {
  const authorized = await contextFor(input.slug);
  if (!authorized.ok) return authorized;
  if (authorized.context.actorRole !== "owner" && authorized.context.actorRole !== "admin") {
    return { ok: false, code: "forbidden" };
  }
  const { data, error } = await createServiceRoleClient().rpc(
    "pair_turniq_primary_offline_device_v1" as never,
    {
      p_salon_id: authorized.context.salonId,
      p_device_id: input.deviceId,
      p_label: input.label,
      p_actor_user_id: authorized.context.actorUserId,
      p_actor_role: authorized.context.actorRole,
      p_occurred_at: new Date().toISOString(),
    } as never,
  );
  if (error) return { ok: false, code: "server_error" };
  const lease = leaseFromRpc(
    authorized.context.salonId,
    authorized.context.actorUserId,
    data as unknown as RpcJson,
  );
  return lease ? { ok: true, lease } : { ok: false, code: "server_error" };
}

export async function revokeTurnIqOfflineDevice(input: {
  slug: string;
  deviceId: string;
  reason: string;
}): Promise<TurnIqOfflineDeviceActionResult> {
  const authorized = await contextFor(input.slug);
  if (!authorized.ok) return authorized;
  if (authorized.context.actorRole !== "owner" && authorized.context.actorRole !== "admin") {
    return { ok: false, code: "forbidden" };
  }
  const { error } = await createServiceRoleClient().rpc(
    "revoke_turniq_primary_offline_device_v1" as never,
    {
      p_salon_id: authorized.context.salonId,
      p_device_id: input.deviceId,
      p_actor_user_id: authorized.context.actorUserId,
      p_actor_role: authorized.context.actorRole,
      p_reason: input.reason,
      p_occurred_at: new Date().toISOString(),
    } as never,
  );
  if (error) return { ok: false, code: "server_error" };
  return inspectTurnIqOfflineDevice(input.slug, input.deviceId);
}

export async function syncTurnIqOfflineSnapshot(input: {
  slug: string;
  deviceId: string;
  deviceGeneration: number;
  policyVersionId: string;
  snapshotFingerprint: string;
  capturedAt: string;
}): Promise<TurnIqOfflineDeviceActionResult> {
  const authorized = await contextFor(input.slug);
  if (!authorized.ok) return authorized;
  if (authorized.context.actorRole !== "owner" && authorized.context.actorRole !== "admin") {
    return { ok: false, code: "forbidden" };
  }
  const { data, error } = await createServiceRoleClient().rpc(
    "sync_turniq_offline_snapshot_v1" as never,
    {
      p_salon_id: authorized.context.salonId,
      p_device_id: input.deviceId,
      p_device_generation: input.deviceGeneration,
      p_policy_version_id: input.policyVersionId,
      p_snapshot_fingerprint: input.snapshotFingerprint,
      p_actor_user_id: authorized.context.actorUserId,
      p_actor_role: authorized.context.actorRole,
      p_captured_at: input.capturedAt,
    } as never,
  );
  if (error) return { ok: false, code: "server_error" };
  const row = data as unknown as RpcJson;
  if (row?.ok !== true) {
    const code = stringValue(row, "code");
    return { ok: false, code: code === "stale_policy" ? "stale_policy" : "device_not_primary" };
  }
  const lease = leaseFromRpc(
    authorized.context.salonId,
    authorized.context.actorUserId,
    row,
  );
  return lease ? { ok: true, lease } : { ok: false, code: "server_error" };
}

export async function resolveTurnIqOfflineReconciliation(input: {
  slug: string;
  deviceId: string;
  conflictId: string;
  reason: string;
}): Promise<TurnIqOfflineReconcileActionResult> {
  const authorized = await contextFor(input.slug);
  if (!authorized.ok) return authorized;
  if (authorized.context.actorRole !== "owner" && authorized.context.actorRole !== "admin") {
    return { ok: false, code: "forbidden" };
  }
  const { data, error } = await createServiceRoleClient().rpc(
    "resolve_turniq_offline_reconciliation_v1" as never,
    {
      p_salon_id: authorized.context.salonId,
      p_device_id: input.deviceId,
      p_conflict_id: input.conflictId,
      p_actor_user_id: authorized.context.actorUserId,
      p_actor_role: authorized.context.actorRole,
      p_reason: input.reason,
      p_resolved_at: new Date().toISOString(),
    } as never,
  );
  if (error) return { ok: false, code: "server_error" };
  const row = data as unknown as RpcJson;
  return row?.ok === true && stringValue(row, "conflict_id") === input.conflictId
    ? { ok: true, conflictId: input.conflictId, status: "resolved" }
    : { ok: false, code: stringValue(row, "code") === "not_found" ? "not_found" : "server_error" };
}

export async function replayTurnIqOfflineCommand(
  slug: string,
  command: TurnIqOfflineCommand,
): Promise<TurnIqOfflineReplayActionResult> {
  const authorized = await contextFor(slug);
  if (!authorized.ok) return authorized;
  if (command.salonId !== authorized.context.salonId) {
    return { ok: false, code: "forbidden" };
  }
  if (command.actorUserId !== authorized.context.actorUserId) {
    return { ok: false, code: "forbidden" };
  }
  const { requestFingerprint: _claimed, ...draft } = command;
  void _claimed;
  if ((await fingerprintTurnIqOfflineCommand(draft)) !== command.requestFingerprint) {
    return { ok: false, code: "command_conflict" };
  }
  const common = {
    p_salon_id: authorized.context.salonId,
    p_policy_version_id: command.policyVersionId,
    p_command_id: command.commandId,
    p_device_id: command.deviceId,
    p_device_generation: command.deviceGeneration,
    p_local_sequence: command.localSequence,
    p_expected_state_version: command.expectedStateVersion,
    p_snapshot_fingerprint: command.snapshotFingerprint,
    p_actor_user_id: authorized.context.actorUserId,
    p_actor_role: authorized.context.actorRole,
    p_request_fingerprint: command.requestFingerprint,
    p_occurred_at: command.clientTimestamp,
  };
  const response = command.body.type === "shift"
    ? await createServiceRoleClient().rpc(
        "apply_turniq_offline_shift_command_v1" as never,
        {
          ...common,
          p_staff_id: command.body.staffId,
          p_command_type: command.body.action,
          p_reason: command.body.reason ?? null,
        } as never,
      )
    : command.body.type === "assignment"
      ? await createServiceRoleClient().rpc(
        "apply_turniq_offline_assignment_command_v1" as never,
        {
          ...common,
          p_assignment_id: command.body.assignmentId,
          p_command_type: command.body.action,
          p_assigned_staff_id: command.body.assignedStaffId ?? null,
          p_override_reason: command.body.reason ?? null,
        } as never,
      )
      : command.body.type === "walkin_intake"
        ? await createServiceRoleClient().rpc(
          "apply_turniq_offline_walkin_command_v1" as never,
          {
            ...common,
            p_local_ticket_id: command.body.localTicketId,
            p_service_id: command.body.serviceId,
            p_party_size: command.body.partySize,
            p_requested_staff_id: command.body.requestedStaffId ?? null,
          } as never,
        )
        : await createServiceRoleClient().rpc(
          "apply_turniq_offline_service_update_command_v1" as never,
          {
            ...common,
            p_assignment_id: command.body.assignmentId,
            p_service_id: command.body.serviceId,
            p_addon_service_ids: command.body.addonServiceIds,
          } as never,
        );
  if (response.error) return { ok: false, code: "server_error" };

  const row = response.data as unknown as RpcJson;
  if (row?.ok !== true) {
    const raw = stringValue(row, "code");
    return {
      ok: false,
      code: offlineConflictCode(raw),
      ...(stringValue(row, "conflict_id") ? { conflictId: stringValue(row, "conflict_id")! } : {}),
    };
  }

  const commandId = stringValue(row, "command_id");
  const aggregateId = stringValue(row, "aggregate_id") ?? stringValue(row, "assignment_id") ?? stringValue(row, "shift_session_id");
  const status = stringValue(row, "status") ?? stringValue(row, "state");
  const stateVersion = numberValue(row, "state_version");
  const offlineStateVersion = numberValue(row, "offline_state_version");
  if (!commandId || !aggregateId || !status || stateVersion === null || offlineStateVersion === null) {
    return { ok: false, code: "server_error" };
  }
  return {
    ok: true,
    result: {
      commandId,
      replayed: row.replayed === true || row.offline_replayed === true,
      aggregateId,
      status,
      stateVersion,
      offlineStateVersion,
      fairnessReceiptId: stringValue(row, "fairness_receipt_id"),
    },
  };
}
