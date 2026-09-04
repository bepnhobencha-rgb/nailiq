import { describe, expect, it, vi } from "vitest";

import type { TurnIqAuthorizedContext } from "@/shared/turniq/actionCore";
import {
  applyTurnIqPinShiftCommandCore,
  configureTurnIqStaffPinCore,
  type TurnIqStaffPinGateway,
} from "@/shared/turniq/staffPin";

const IDS = {
  salon: "11111111-1111-4111-8111-111111111111",
  policy: "22222222-2222-4222-8222-222222222222",
  staff: "33333333-3333-4333-8333-333333333333",
  otherStaff: "44444444-4444-4444-8444-444444444444",
  command: "55555555-5555-4555-8555-555555555555",
  device: "66666666-6666-4666-8666-666666666666",
  user: "77777777-7777-4777-8777-777777777777",
};

function context(
  overrides: Partial<TurnIqAuthorizedContext> = {},
): TurnIqAuthorizedContext {
  return {
    salonId: IDS.salon,
    actorUserId: IDS.user,
    actorRole: "receptionist",
    actorStaffId: null,
    featureEnabled: true,
    rolloutStage: "supervised",
    ...overrides,
  };
}

function gateway(
  overrides: Partial<TurnIqStaffPinGateway> = {},
): TurnIqStaffPinGateway {
  return {
    resolveContext: vi.fn(async () => context()),
    configurePin: vi.fn(async (args) => ({
      ok: true,
      command_id: args.commandId,
      replayed: false,
      staff_id: args.staffId,
      pin_version: 1,
      configured_at: args.occurredAt,
    })),
    applyPinShift: vi.fn(async (args) => ({
      ok: true,
      command_id: args.commandId,
      replayed: false,
      shift_session_id: "88888888-8888-4888-8888-888888888888",
      state: args.commandType === "break" ? "approved_break" : "active",
      state_version: 1,
    })),
    ...overrides,
  };
}

const configureInput = {
  slug: "salon-a",
  staffId: IDS.staff,
  pin: "2468",
  commandId: IDS.command,
};

const shiftInput = {
  slug: "salon-a",
  policyVersionId: IDS.policy,
  staffId: IDS.staff,
  pin: "2468",
  commandId: IDS.command,
  deviceId: IDS.device,
  localSequence: 1,
  command: { type: "check_in" as const },
};

describe("TurnIQ staff PIN boundary", () => {
  it("validates a short numeric PIN before resolving authorization", async () => {
    const api = gateway();
    await expect(
      applyTurnIqPinShiftCommandCore(
        { ...shiftInput, pin: "12" },
        api,
        () => "2026-09-03T18:00:00.000Z",
      ),
    ).resolves.toEqual({ ok: false, code: "invalid_input" });
    expect(api.resolveContext).not.toHaveBeenCalled();
    expect(api.applyPinShift).not.toHaveBeenCalled();
  });

  it("allows only Owner/Admin to configure or rotate a PIN", async () => {
    const receptionist = gateway();
    await expect(
      configureTurnIqStaffPinCore(
        configureInput,
        receptionist,
        () => "2026-09-03T18:00:00.000Z",
      ),
    ).resolves.toEqual({ ok: false, code: "forbidden" });
    expect(receptionist.configurePin).not.toHaveBeenCalled();

    const owner = gateway({
      resolveContext: vi.fn(async () => context({ actorRole: "owner" })),
    });
    await expect(
      configureTurnIqStaffPinCore(
        configureInput,
        owner,
        () => "2026-09-03T18:00:00.000Z",
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { staffId: IDS.staff, pinVersion: 1 },
    });
    expect(owner.configurePin).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: IDS.salon,
        actorUserId: IDS.user,
        actorRole: "owner",
        pin: "2468",
      }),
    );
  });

  it("keeps shared-device PIN shift actions blocked in Shadow", async () => {
    const api = gateway({
      resolveContext: vi.fn(async () => context({ rolloutStage: "shadow" })),
    });
    await expect(
      applyTurnIqPinShiftCommandCore(
        shiftInput,
        api,
        () => "2026-09-03T18:00:00.000Z",
      ),
    ).resolves.toEqual({ ok: false, code: "rollout_stage_blocked" });
    expect(api.applyPinShift).not.toHaveBeenCalled();
  });

  it("lets a nail technician authenticate only their own shift", async () => {
    const api = gateway({
      resolveContext: vi.fn(async () =>
        context({ actorRole: "nail_tech", actorStaffId: IDS.otherStaff }),
      ),
    });
    await expect(
      applyTurnIqPinShiftCommandCore(
        shiftInput,
        api,
        () => "2026-09-03T18:00:00.000Z",
      ),
    ).resolves.toEqual({ ok: false, code: "forbidden" });
    expect(api.applyPinShift).not.toHaveBeenCalled();
  });

  it("never includes the raw PIN in the durable request fingerprint", async () => {
    const calls: Parameters<TurnIqStaffPinGateway["applyPinShift"]>[0][] = [];
    const api = gateway({
      applyPinShift: vi.fn(async (args) => {
        calls.push(args);
        return {
          ok: true,
          command_id: args.commandId,
          shift_session_id: "88888888-8888-4888-8888-888888888888",
          state: "active",
          state_version: 1,
        };
      }),
    });
    await applyTurnIqPinShiftCommandCore(
      shiftInput,
      api,
      () => "2026-09-03T18:00:00.000Z",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0].requestFingerprint).not.toContain(shiftInput.pin);
    expect(JSON.stringify(calls[0])).toContain('"pin":"2468"');
    expect(JSON.stringify({ fingerprint: calls[0].requestFingerprint })).not.toContain(
      shiftInput.pin,
    );
  });

  it("maps bounded lockout responses without disclosing credential details", async () => {
    const api = gateway({
      applyPinShift: vi.fn(async () => ({ ok: false, code: "pin_locked" })),
    });
    await expect(
      applyTurnIqPinShiftCommandCore(
        shiftInput,
        api,
        () => "2026-09-03T18:00:00.000Z",
      ),
    ).resolves.toEqual({ ok: false, code: "pin_locked" });
  });
});
