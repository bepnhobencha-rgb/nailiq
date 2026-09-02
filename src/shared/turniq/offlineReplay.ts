import type {
  TurnIqOfflineCommand,
  TurnIqOfflineConflictCode,
  TurnIqOfflineLease,
} from "@/shared/turniq/offlineContracts";
import { isOfflineCommandAllowed } from "@/shared/turniq/offlineContracts";

export type TurnIqOfflineReplayPlan =
  | {
      ok: true;
      commands: readonly TurnIqOfflineCommand[];
      finalExpectedStateVersion: number;
    }
  | {
      ok: false;
      code: TurnIqOfflineConflictCode;
      commandId: string | null;
    };

/**
 * Pure fail-closed replay planner. It never mutates local or server state.
 * The server repeats every check while holding the salon offline-state lock.
 */
export function planTurnIqOfflineReplay(input: {
  lease: TurnIqOfflineLease;
  policyVersionId: string;
  snapshotFingerprint: string;
  serverStateVersion: number;
  commands: readonly TurnIqOfflineCommand[];
}): TurnIqOfflineReplayPlan {
  if (input.lease.status !== "primary") {
    return { ok: false, code: "device_not_primary", commandId: null };
  }

  const ids = new Map<string, TurnIqOfflineCommand>();
  for (const command of input.commands) {
    const prior = ids.get(command.commandId);
    if (prior && (
      prior.requestFingerprint !== command.requestFingerprint ||
      prior.localSequence !== command.localSequence
    )) {
      return {
        ok: false,
        code: "command_conflict",
        commandId: command.commandId,
      };
    }
    ids.set(command.commandId, command);
  }

  const commands = [...ids.values()].sort(
    (left, right) => left.localSequence - right.localSequence,
  );
  let nextSequence = input.lease.lastAckedSequence + 1;
  let nextVersion = input.serverStateVersion;

  for (const command of commands) {
    if (
      command.salonId !== input.lease.salonId ||
      command.deviceId !== input.lease.deviceId
    ) {
      return {
        ok: false,
        code: "device_not_primary",
        commandId: command.commandId,
      };
    }
    if (command.deviceGeneration !== input.lease.generation) {
      return {
        ok: false,
        code: "device_generation_stale",
        commandId: command.commandId,
      };
    }
    if (command.policyVersionId !== input.policyVersionId) {
      return {
        ok: false,
        code: "stale_policy",
        commandId: command.commandId,
      };
    }
    if (command.snapshotFingerprint !== input.snapshotFingerprint) {
      return {
        ok: false,
        code: "stale_snapshot",
        commandId: command.commandId,
      };
    }
    if (command.localSequence !== nextSequence) {
      return {
        ok: false,
        code: "sequence_gap",
        commandId: command.commandId,
      };
    }
    if (command.expectedStateVersion !== nextVersion) {
      return {
        ok: false,
        code: "stale_snapshot",
        commandId: command.commandId,
      };
    }
    if (!isOfflineCommandAllowed(command.body)) {
      return {
        ok: false,
        code: "domain_conflict",
        commandId: command.commandId,
      };
    }

    nextSequence += 1;
    nextVersion += 1;
  }

  return { ok: true, commands, finalExpectedStateVersion: nextVersion };
}
