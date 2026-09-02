import { describe, expect, it } from "vitest";

import type {
  TurnIqOfflineCommand,
  TurnIqOfflineLease,
} from "@/shared/turniq/offlineContracts";
import { planTurnIqOfflineReplay } from "@/shared/turniq/offlineReplay";

const IDS = {
  salon: "00000000-0000-4000-8000-000000000001",
  device: "00000000-0000-4000-8000-000000000002",
  policy: "00000000-0000-4000-8000-000000000003",
  actor: "00000000-0000-4000-8000-000000000004",
  staff: "00000000-0000-4000-8000-000000000005",
  assignment: "00000000-0000-4000-8000-000000000006",
} as const;
const FINGERPRINT = "a".repeat(64);

function lease(patch: Partial<TurnIqOfflineLease> = {}): TurnIqOfflineLease {
  return {
    salonId: IDS.salon,
    deviceId: IDS.device,
    actorUserId: IDS.actor,
    generation: 4,
    status: "primary",
    stateVersion: 20,
    lastAckedSequence: 7,
    ...patch,
  };
}

function command(
  localSequence: number,
  expectedStateVersion: number,
  patch: Partial<TurnIqOfflineCommand> = {},
): TurnIqOfflineCommand {
  return {
    schemaVersion: 1,
    commandId: `00000000-0000-4000-8000-${String(localSequence).padStart(12, "0")}`,
    salonId: IDS.salon,
    deviceId: IDS.device,
    deviceGeneration: 4,
    policyVersionId: IDS.policy,
    localSequence,
    expectedStateVersion,
    actorUserId: IDS.actor,
    clientTimestamp: "2026-09-02T18:00:00.000Z",
    snapshotFingerprint: FINGERPRINT,
    requestFingerprint: String(localSequence % 10).repeat(64),
    body: {
      type: "shift",
      staffId: IDS.staff,
      action: "check_in",
    },
    ...patch,
  };
}

describe("planTurnIqOfflineReplay", () => {
  it("orders a contiguous outbox and advances one state version per command", () => {
    const result = planTurnIqOfflineReplay({
      lease: lease(),
      policyVersionId: IDS.policy,
      snapshotFingerprint: FINGERPRINT,
      serverStateVersion: 20,
      commands: [command(9, 21), command(8, 20)],
    });
    expect(result).toMatchObject({ ok: true, finalExpectedStateVersion: 22 });
    if (result.ok) expect(result.commands.map((item) => item.localSequence)).toEqual([8, 9]);
  });

  it("blocks a second or revoked device before any command is replayed", () => {
    expect(
      planTurnIqOfflineReplay({
        lease: lease({ status: "read_only" }),
        policyVersionId: IDS.policy,
        snapshotFingerprint: FINGERPRINT,
        serverStateVersion: 20,
        commands: [command(8, 20)],
      }),
    ).toEqual({ ok: false, code: "device_not_primary", commandId: null });
  });

  it("stops on a missing local sequence instead of reordering across the gap", () => {
    expect(
      planTurnIqOfflineReplay({
        lease: lease(),
        policyVersionId: IDS.policy,
        snapshotFingerprint: FINGERPRINT,
        serverStateVersion: 20,
        commands: [command(9, 20)],
      }),
    ).toMatchObject({ ok: false, code: "sequence_gap" });
  });

  it("stops on server drift before replay", () => {
    expect(
      planTurnIqOfflineReplay({
        lease: lease(),
        policyVersionId: IDS.policy,
        snapshotFingerprint: FINGERPRINT,
        serverStateVersion: 21,
        commands: [command(8, 20)],
      }),
    ).toMatchObject({ ok: false, code: "stale_snapshot" });
  });

  it("rejects a stale device generation and stale policy", () => {
    expect(
      planTurnIqOfflineReplay({
        lease: lease(),
        policyVersionId: IDS.policy,
        snapshotFingerprint: FINGERPRINT,
        serverStateVersion: 20,
        commands: [command(8, 20, { deviceGeneration: 3 })],
      }),
    ).toMatchObject({ ok: false, code: "device_generation_stale" });

    expect(
      planTurnIqOfflineReplay({
        lease: lease(),
        policyVersionId: "00000000-0000-4000-8000-000000000099",
        snapshotFingerprint: FINGERPRINT,
        serverStateVersion: 20,
        commands: [command(8, 20)],
      }),
    ).toMatchObject({ ok: false, code: "stale_policy" });
  });

  it("rejects an unsafe override without a reason", () => {
    expect(
      planTurnIqOfflineReplay({
        lease: lease(),
        policyVersionId: IDS.policy,
        snapshotFingerprint: FINGERPRINT,
        serverStateVersion: 20,
        commands: [
          command(8, 20, {
            body: {
              type: "assignment",
              assignmentId: IDS.assignment,
              action: "override",
              assignedStaffId: IDS.staff,
            },
          }),
        ],
      }),
    ).toMatchObject({ ok: false, code: "domain_conflict" });
  });

  it("deduplicates an exact retry but rejects a reused command id with another fingerprint", () => {
    const exact = command(8, 20);
    const exactRetry = structuredClone(exact);
    const exactResult = planTurnIqOfflineReplay({
      lease: lease(),
      policyVersionId: IDS.policy,
      snapshotFingerprint: FINGERPRINT,
      serverStateVersion: 20,
      commands: [exact, exactRetry],
    });
    expect(exactResult).toMatchObject({ ok: true, finalExpectedStateVersion: 21 });
    if (exactResult.ok) expect(exactResult.commands).toHaveLength(1);

    expect(
      planTurnIqOfflineReplay({
        lease: lease(),
        policyVersionId: IDS.policy,
        snapshotFingerprint: FINGERPRINT,
        serverStateVersion: 20,
        commands: [exact, { ...exact, requestFingerprint: "b".repeat(64) }],
      }),
    ).toMatchObject({ ok: false, code: "command_conflict", commandId: exact.commandId });
  });

  it("rejects a command copied from another salon or device", () => {
    expect(
      planTurnIqOfflineReplay({
        lease: lease(),
        policyVersionId: IDS.policy,
        snapshotFingerprint: FINGERPRINT,
        serverStateVersion: 20,
        commands: [command(8, 20, { salonId: "00000000-0000-4000-8000-000000000099" })],
      }),
    ).toMatchObject({ ok: false, code: "device_not_primary" });
  });
});
