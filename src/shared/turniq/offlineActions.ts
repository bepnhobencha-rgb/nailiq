"use server";

import {
  turnIqOfflineDeviceActionSchema,
  turnIqOfflinePairActionSchema,
  turnIqOfflineReconcileActionSchema,
  turnIqOfflineReplayActionSchema,
  turnIqOfflineRevokeActionSchema,
  turnIqOfflineSnapshotActionSchema,
} from "@/shared/turniq/offlineContracts";
import {
  inspectTurnIqOfflineDevice,
  pairTurnIqOfflineDevice,
  replayTurnIqOfflineCommand,
  resolveTurnIqOfflineReconciliation,
  revokeTurnIqOfflineDevice,
  syncTurnIqOfflineSnapshot,
} from "@/shared/turniq/offlineServer";

export async function inspectTurnIqOfflineDeviceAction(input: unknown) {
  const parsed = turnIqOfflineDeviceActionSchema.safeParse(input);
  return parsed.success
    ? inspectTurnIqOfflineDevice(parsed.data.slug, parsed.data.deviceId)
    : { ok: false as const, code: "invalid_input" as const };
}

export async function pairTurnIqOfflineDeviceAction(input: unknown) {
  const parsed = turnIqOfflinePairActionSchema.safeParse(input);
  return parsed.success
    ? pairTurnIqOfflineDevice(parsed.data)
    : { ok: false as const, code: "invalid_input" as const };
}

export async function revokeTurnIqOfflineDeviceAction(input: unknown) {
  const parsed = turnIqOfflineRevokeActionSchema.safeParse(input);
  return parsed.success
    ? revokeTurnIqOfflineDevice(parsed.data)
    : { ok: false as const, code: "invalid_input" as const };
}

export async function syncTurnIqOfflineSnapshotAction(input: unknown) {
  const parsed = turnIqOfflineSnapshotActionSchema.safeParse(input);
  return parsed.success
    ? syncTurnIqOfflineSnapshot(parsed.data)
    : { ok: false as const, code: "invalid_input" as const };
}

export async function replayTurnIqOfflineCommandAction(input: unknown) {
  const parsed = turnIqOfflineReplayActionSchema.safeParse(input);
  return parsed.success
    ? replayTurnIqOfflineCommand(parsed.data.slug, parsed.data.command)
    : { ok: false as const, code: "invalid_input" as const };
}

export async function resolveTurnIqOfflineReconciliationAction(input: unknown) {
  const parsed = turnIqOfflineReconcileActionSchema.safeParse(input);
  return parsed.success
    ? resolveTurnIqOfflineReconciliation(parsed.data)
    : { ok: false as const, code: "invalid_input" as const };
}
