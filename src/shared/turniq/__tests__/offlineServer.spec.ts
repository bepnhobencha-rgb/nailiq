import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ context: vi.fn(), rpc: vi.fn() }));
vi.mock("@/shared/turniq/serverDal", () => ({ resolveTurnIqContext: mocks.context }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));

import { buildTurnIqOfflineCommand, TURNIQ_OFFLINE_SCHEMA_VERSION } from "@/shared/turniq/offlineContracts";
import { pairTurnIqOfflineDevice, replayTurnIqOfflineCommand, resolveTurnIqOfflineReconciliation } from "@/shared/turniq/offlineServer";

const IDS = {
  salon: "10000000-0000-4000-8000-000000000001",
  device: "10000000-0000-4000-8000-000000000002",
  actor: "10000000-0000-4000-8000-000000000003",
  policy: "10000000-0000-4000-8000-000000000004",
  staff: "10000000-0000-4000-8000-000000000005",
  command: "10000000-0000-4000-8000-000000000006",
};

async function command() {
  return buildTurnIqOfflineCommand({
    snapshot: {
      schemaVersion: TURNIQ_OFFLINE_SCHEMA_VERSION,
      salonId: IDS.salon,
      deviceId: IDS.device,
      actorUserId: IDS.actor,
      policyVersionId: IDS.policy,
      deviceGeneration: 2,
      stateVersion: 8,
      lastAckedSequence: 4,
      snapshotFingerprint: "a".repeat(64),
      capturedAt: "2026-09-02T20:00:00.000Z",
      payload: {},
    },
    pendingCount: 0,
    commandId: IDS.command,
    clientTimestamp: "2026-09-02T20:01:00.000Z",
    body: { type: "shift", staffId: IDS.staff, action: "check_in" },
  });
}

describe("TurnIQ offline server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({
      salonId: IDS.salon,
      actorUserId: IDS.actor,
      actorRole: "owner",
      featureEnabled: true,
    });
  });

  it("pairs only through the salon-scoped service-role RPC", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        ok: true,
        device_id: IDS.device,
        device_generation: 2,
        state_version: 8,
        last_acked_sequence: 0,
        status: "primary",
      },
      error: null,
    });
    await expect(pairTurnIqOfflineDevice({ slug: "qa-salon", deviceId: IDS.device, label: "QA tablet" }))
      .resolves.toMatchObject({ ok: true, lease: { salonId: IDS.salon, generation: 2 } });
    expect(mocks.rpc).toHaveBeenCalledWith("pair_turniq_primary_offline_device_v1", expect.objectContaining({
      p_salon_id: IDS.salon,
      p_device_id: IDS.device,
      p_actor_user_id: IDS.actor,
      p_actor_role: "owner",
    }));
  });

  it("rejects a command from another salon or actor before RPC", async () => {
    const valid = await command();
    await expect(replayTurnIqOfflineCommand("qa-salon", { ...valid, salonId: crypto.randomUUID() }))
      .resolves.toEqual({ ok: false, code: "forbidden" });
    await expect(replayTurnIqOfflineCommand("qa-salon", { ...valid, actorUserId: crypto.randomUUID() }))
      .resolves.toEqual({ ok: false, code: "forbidden" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("recomputes the fingerprint and rejects altered payloads", async () => {
    const valid = await command();
    const altered = {
      ...valid,
      body: { type: "shift" as const, staffId: IDS.staff, action: "check_out" as const },
    };
    await expect(replayTurnIqOfflineCommand("qa-salon", altered))
      .resolves.toEqual({ ok: false, code: "command_conflict" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns exact committed truth and keeps provider work absent", async () => {
    const valid = await command();
    mocks.rpc.mockResolvedValue({
      data: {
        ok: true,
        command_id: valid.commandId,
        shift_session_id: IDS.staff,
        state: "active",
        state_version: 1,
        offline_state_version: 9,
        replayed: false,
      },
      error: null,
    });
    await expect(replayTurnIqOfflineCommand("qa-salon", valid)).resolves.toMatchObject({
      ok: true,
      result: { commandId: valid.commandId, status: "active", offlineStateVersion: 9 },
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(String(mocks.rpc.mock.calls[0]?.[0])).toBe("apply_turniq_offline_shift_command_v1");
    expect(JSON.stringify(mocks.rpc.mock.calls[0]?.[1])).not.toMatch(/twilio|resend|square|stripe|email|sms/i);
  });

  it("routes PII-free walk-in and schedule-neutral service commands to dedicated RPCs", async () => {
    const base = await command();
    const cases = [
      {
        name: "apply_turniq_offline_walkin_command_v1",
        body: {
          type: "walkin_intake" as const,
          localTicketId: crypto.randomUUID(),
          serviceId: crypto.randomUUID(),
          partySize: 2,
        },
      },
      {
        name: "apply_turniq_offline_service_update_command_v1",
        body: {
          type: "service_update" as const,
          assignmentId: crypto.randomUUID(),
          serviceId: crypto.randomUUID(),
          addonServiceIds: [crypto.randomUUID()],
        },
      },
    ];
    for (const entry of cases) {
      mocks.rpc.mockReset();
      const draft = { ...base, commandId: crypto.randomUUID(), body: entry.body };
      const { requestFingerprint: _old, ...material } = draft;
      void _old;
      const requestFingerprint = await import("@/shared/turniq/offlineContracts")
        .then(({ fingerprintTurnIqOfflineCommand }) => fingerprintTurnIqOfflineCommand(material));
      mocks.rpc.mockResolvedValue({
        data: {
          ok: true,
          command_id: draft.commandId,
          aggregate_id: crypto.randomUUID(),
          status: "waiting",
          state_version: 1,
          offline_state_version: 9,
        },
        error: null,
      });
      await expect(replayTurnIqOfflineCommand("qa-salon", { ...draft, requestFingerprint }))
        .resolves.toMatchObject({ ok: true });
      expect(mocks.rpc).toHaveBeenCalledWith(entry.name, expect.any(Object));
      expect(JSON.stringify(mocks.rpc.mock.calls[0]?.[1])).not.toMatch(/phone|email|customer_name/i);
    }
  });

  it("lets only owner/admin resolve a same-salon reconciliation with a reason", async () => {
    const conflictId = crypto.randomUUID();
    mocks.rpc.mockResolvedValue({
      data: { ok: true, conflict_id: conflictId, status: "resolved" },
      error: null,
    });
    await expect(resolveTurnIqOfflineReconciliation({
      slug: "qa-salon",
      deviceId: IDS.device,
      conflictId,
      reason: "Server assignment is authoritative",
    })).resolves.toEqual({ ok: true, conflictId, status: "resolved" });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "resolve_turniq_offline_reconciliation_v1",
      expect.objectContaining({
        p_salon_id: IDS.salon,
        p_conflict_id: conflictId,
        p_actor_user_id: IDS.actor,
        p_actor_role: "owner",
      }),
    );

    mocks.rpc.mockClear();
    mocks.context.mockResolvedValueOnce({
      salonId: IDS.salon,
      actorUserId: IDS.actor,
      actorRole: "receptionist",
      featureEnabled: true,
    });
    await expect(resolveTurnIqOfflineReconciliation({
      slug: "qa-salon",
      deviceId: IDS.device,
      conflictId,
      reason: "Attempt",
    })).resolves.toEqual({ ok: false, code: "forbidden" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
