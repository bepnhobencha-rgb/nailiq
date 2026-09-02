import { describe, expect, it, vi } from "vitest";

import {
  applyTurnIqExceptionCommandCore,
  applyTurnIqAssignmentCommandCore,
  applyTurnIqCorrectionCommandCore,
  applyTurnIqRefusalCommandCore,
  applyTurnIqRedoCommandCore,
  applyTurnIqShiftCommandCore,
  applyTurnIqSwapCommandCore,
  createTurnIqDisputeCore,
  createTurnIqSkipDisputeCore,
  resolveTurnIqDisputeCore,
  type TurnIqActionGateway,
  type TurnIqAuthorizedContext,
} from "@/shared/turniq/actionCore";

const IDS = {
  policy: "11111111-1111-4111-8111-111111111111",
  command: "22222222-2222-4222-8222-222222222222",
  device: "33333333-3333-4333-8333-333333333333",
  staff: "44444444-4444-4444-8444-444444444444",
  otherStaff: "55555555-5555-4555-8555-555555555555",
  assignment: "66666666-6666-4666-8666-666666666666",
  user: "77777777-7777-4777-8777-777777777777",
  receipt: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  dispute: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  exception: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  originalAssignment: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};

function context(
  overrides: Partial<TurnIqAuthorizedContext> = {},
): TurnIqAuthorizedContext {
  return {
    salonId: "88888888-8888-4888-8888-888888888888",
    actorUserId: IDS.user,
    actorRole: "receptionist",
    actorStaffId: null,
    featureEnabled: true,
    rolloutStage: "supervised",
    ...overrides,
  };
}

function gateway(overrides: Partial<TurnIqActionGateway> = {}): TurnIqActionGateway {
  return {
    resolveContext: vi.fn(async () => context()),
    loadAssignment: vi.fn(async () => ({ assignedStaffId: IDS.staff })),
    applyShift: vi.fn(async (args) => ({
      ok: true,
      command_id: args.commandId,
      replayed: false,
      shift_session_id: "99999999-9999-4999-8999-999999999999",
      state: "active",
      state_version: 1,
    })),
    applyAssignment: vi.fn(async (args) => ({
      ok: true,
      command_id: args.commandId,
      replayed: false,
      assignment_id: args.assignmentId,
      status: "in_progress",
      state_version: 3,
    })),
    applyRefusal: vi.fn(async (args) => ({
      ok: true,
      command_id: args.commandId,
      replayed: false,
      assignment_id: args.assignmentId,
      status: "rejected",
      state_version: 2,
    })),
    applyRedo: vi.fn(async (args) => ({
      ok: true,
      command_id: args.commandId,
      replayed: false,
      assignment_id: args.assignmentId,
      status: "recommended",
      state_version: 2,
    })),
    applySwap: vi.fn(async (args) => ({
      ok: true,
      command_id: args.commandId,
      swap_id: args.swapId ?? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      status: args.commandType === "confirm_swap" ? "applied" : "pending_consents",
      state_version: 1,
    })),
    applyCorrection: vi.fn(async (args) => ({
      ok: true,
      command_id: args.commandId,
      correction_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      status: "completed",
      state_version: 4,
    })),
    createDispute: vi.fn(async (args) => ({
      ok: true,
      command_id: args.commandId,
      aggregate_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "open",
      state_version: 1,
    })),
    createSkipDispute: vi.fn(async (args) => ({
      ok: true,
      command_id: args.commandId,
      aggregate_id: IDS.dispute,
      status: "open",
      state_version: 1,
    })),
    resolveDispute: vi.fn(async (args) => ({
      ok: true,
      command_id: args.commandId,
      aggregate_id: args.disputeId,
      status: args.resolutionStatus,
      state_version: 2,
    })),
    applyException: vi.fn(async (args) => ({
      ok: true,
      command_id: args.commandId,
      aggregate_id: args.exceptionId,
      status: args.commandType === "acknowledge_exception" ? "acknowledged" : "resolved",
      state_version: 2,
    })),
    ...overrides,
  };
}

const shiftInput = {
  slug: "salon-a",
  policyVersionId: IDS.policy,
  staffId: IDS.staff,
  commandId: IDS.command,
  deviceId: IDS.device,
  localSequence: 1,
  command: { type: "check_in" as const },
};

const assignmentInput = {
  slug: "salon-a",
  policyVersionId: IDS.policy,
  assignmentId: IDS.assignment,
  commandId: IDS.command,
  deviceId: IDS.device,
  localSequence: 2,
  command: { type: "start" as const },
};

describe("TurnIQ M3B server action core", () => {
  it("fails before authorization for malformed command envelopes", async () => {
    const api = gateway();
    const result = await applyTurnIqShiftCommandCore(
      { ...shiftInput, commandId: "not-a-uuid" },
      api,
      () => "2026-09-02T18:00:00.000Z",
    );
    expect(result).toEqual({ ok: false, code: "invalid_input" });
    expect(api.resolveContext).not.toHaveBeenCalled();
  });

  it("fails closed when membership is absent or the feature is off", async () => {
    const unauthenticated = gateway({ resolveContext: vi.fn(async () => null) });
    expect(
      await applyTurnIqShiftCommandCore(
        shiftInput,
        unauthenticated,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toEqual({ ok: false, code: "unauthorized" });

    const disabled = gateway({
      resolveContext: vi.fn(async () => context({ featureEnabled: false })),
    });
    expect(
      await applyTurnIqShiftCommandCore(
        shiftInput,
        disabled,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toEqual({ ok: false, code: "feature_disabled" });
    expect(disabled.applyShift).not.toHaveBeenCalled();
  });

  it("keeps shadow mode read-only and permits supervised commands", async () => {
    const shadow = gateway({
      resolveContext: vi.fn(async () => context({ rolloutStage: "shadow" })),
    });
    await expect(
      applyTurnIqShiftCommandCore(
        shiftInput,
        shadow,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).resolves.toEqual({ ok: false, code: "rollout_stage_blocked" });
    expect(shadow.applyShift).not.toHaveBeenCalled();

    const supervised = gateway();
    await expect(
      applyTurnIqShiftCommandCore(
        shiftInput,
        supervised,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(supervised.applyShift).toHaveBeenCalledTimes(1);
  });

  it("allows a nail tech to mutate only their own shift", async () => {
    const api = gateway({
      resolveContext: vi.fn(async () =>
        context({ actorRole: "nail_tech", actorStaffId: IDS.otherStaff }),
      ),
    });
    expect(
      await applyTurnIqShiftCommandCore(
        shiftInput,
        api,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(api.applyShift).not.toHaveBeenCalled();
  });

  it("derives actor, salon, timestamp and stable retry fingerprint server-side", async () => {
    const calls: Parameters<TurnIqActionGateway["applyShift"]>[0][] = [];
    const api = gateway({
      applyShift: vi.fn(async (args) => {
        calls.push(args);
        return {
          ok: true,
          command_id: args.commandId,
          replayed: calls.length > 1,
          shift_session_id: "99999999-9999-4999-8999-999999999999",
          state: "active",
          state_version: 1,
        };
      }),
    });
    await applyTurnIqShiftCommandCore(
      shiftInput,
      api,
      () => "2026-09-02T18:00:00.000Z",
    );
    await applyTurnIqShiftCommandCore(
      shiftInput,
      api,
      () => "2026-09-02T18:01:00.000Z",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].salonId).toBe(context().salonId);
    expect(calls[0].actorUserId).toBe(IDS.user);
    expect(calls[0].occurredAt).toBe("2026-09-02T18:00:00.000Z");
    expect(calls[1].occurredAt).toBe("2026-09-02T18:01:00.000Z");
    expect(calls[0].requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[1].requestFingerprint).toBe(calls[0].requestFingerprint);
  });

  it("allows own start/complete but blocks a nail tech from another assignment", async () => {
    const own = gateway({
      resolveContext: vi.fn(async () =>
        context({ actorRole: "nail_tech", actorStaffId: IDS.staff }),
      ),
    });
    expect(
      await applyTurnIqAssignmentCommandCore(
        assignmentInput,
        own,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toMatchObject({ ok: true });

    const other = gateway({
      resolveContext: vi.fn(async () =>
        context({ actorRole: "nail_tech", actorStaffId: IDS.otherStaff }),
      ),
    });
    expect(
      await applyTurnIqAssignmentCommandCore(
        assignmentInput,
        other,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(other.applyAssignment).not.toHaveBeenCalled();
  });

  it("returns the audited owner-confirmation exception without raw database data", async () => {
    const api = gateway({
      applyAssignment: vi.fn(async () => ({
        ok: false,
        code: "owner_confirmation_required",
        command_id: IDS.command,
        exception_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        assignment_id: IDS.assignment,
        status: "recommended",
        state_version: 1,
      })),
    });
    expect(
      await applyTurnIqAssignmentCommandCore(
        {
          ...assignmentInput,
          command: {
            type: "override",
            assignedStaffId: IDS.staff,
            reason: "Customer asked in person",
          },
        },
        api,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toEqual({
      ok: false,
      code: "owner_confirmation_required",
      exceptionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
  });

  it("keeps refusal classification desk-only and derives its fingerprint server-side", async () => {
    const input = {
      slug: "salon-a",
      policyVersionId: IDS.policy,
      assignmentId: IDS.assignment,
      commandId: IDS.command,
      deviceId: IDS.device,
      localSequence: 7,
      command: {
        type: "refuse" as const,
        category: "unapproved_refusal" as const,
        reason: "Technician declined an eligible customer.",
      },
    };
    const tech = gateway({
      resolveContext: vi.fn(async () =>
        context({ actorRole: "nail_tech", actorStaffId: IDS.staff }),
      ),
    });
    expect(
      await applyTurnIqRefusalCommandCore(
        input,
        tech,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(tech.applyRefusal).not.toHaveBeenCalled();

    const desk = gateway();
    expect(
      await applyTurnIqRefusalCommandCore(
        input,
        desk,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toMatchObject({ ok: true, result: { status: "rejected" } });
    expect(desk.applyRefusal).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: context().salonId,
        assignmentId: IDS.assignment,
        category: "unapproved_refusal",
        reason: "Technician declined an eligible customer.",
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it("keeps redo classification desk-only and never accepts policy outcomes from the browser", async () => {
    const input = {
      slug: "salon-a",
      policyVersionId: IDS.policy,
      assignmentId: IDS.assignment,
      commandId: IDS.command,
      deviceId: IDS.device,
      localSequence: 8,
      command: {
        type: "redo" as const,
        originalAssignmentId: IDS.originalAssignment,
        category: "quality_issue" as const,
        note: "Repair one chipped nail under the salon guarantee.",
      },
    };
    const tech = gateway({
      resolveContext: vi.fn(async () =>
        context({ actorRole: "nail_tech", actorStaffId: IDS.staff }),
      ),
    });
    expect(
      await applyTurnIqRedoCommandCore(
        input,
        tech,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(tech.applyRedo).not.toHaveBeenCalled();

    const desk = gateway();
    expect(
      await applyTurnIqRedoCommandCore(
        input,
        desk,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toMatchObject({ ok: true, result: { status: "recommended" } });
    expect(desk.applyRedo).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: context().salonId,
        assignmentId: IDS.assignment,
        originalAssignmentId: IDS.originalAssignment,
        category: "quality_issue",
        note: "Repair one chipped nail under the salon guarantee.",
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(desk.applyRedo).not.toHaveBeenCalledWith(
      expect.objectContaining({ consumesTurn: expect.anything() }),
    );
  });

  it("returns the audited policy exception without changing the assignment", async () => {
    const api = gateway({
      applyRedo: vi.fn(async (args) => ({
        ok: false,
        code: "policy_configuration_required",
        command_id: args.commandId,
        exception_id: IDS.exception,
        assignment_id: args.assignmentId,
        status: "recommended",
        state_version: 1,
      })),
    });
    expect(
      await applyTurnIqRedoCommandCore(
        {
          slug: "salon-a",
          policyVersionId: IDS.policy,
          assignmentId: IDS.assignment,
          commandId: IDS.command,
          deviceId: IDS.device,
          localSequence: 9,
          command: {
            type: "redo",
            originalAssignmentId: IDS.originalAssignment,
            category: "other",
            note: "Owner review needed.",
          },
        },
        api,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toEqual({
      ok: false,
      code: "policy_configuration_required",
      exceptionId: IDS.exception,
    });
  });

  it("allows an active technician identity to dispute only through the trusted RPC", async () => {
    const noStaff = gateway();
    const input = {
      slug: "salon-a",
      policyVersionId: IDS.policy,
      fairnessReceiptId: IDS.receipt,
      commandId: IDS.command,
      deviceId: IDS.device,
      localSequence: 3,
      command: {
        type: "dispute" as const,
        category: "assignment" as const,
        reason: "I believe the recorded assignment needs review.",
      },
    };
    expect(
      await createTurnIqDisputeCore(
        input,
        noStaff,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(noStaff.createDispute).not.toHaveBeenCalled();

    const own = gateway({
      resolveContext: vi.fn(async () =>
        context({ actorRole: "nail_tech", actorStaffId: IDS.staff }),
      ),
    });
    expect(
      await createTurnIqDisputeCore(
        input,
        own,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toMatchObject({ ok: true, result: { status: "open" } });
    expect(own.createDispute).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: context().salonId,
        actorUserId: IDS.user,
        fairnessReceiptId: IDS.receipt,
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it("lets an active technician request review of only their persisted skip decision", async () => {
    const input = {
      slug: "salon-a",
      policyVersionId: IDS.policy,
      assignmentId: IDS.assignment,
      commandId: IDS.command,
      deviceId: IDS.device,
      localSequence: 4,
      command: {
        type: "dispute" as const,
        category: "skip_reason" as const,
        reason: "Please review why I was skipped.",
      },
    };
    const noStaff = gateway();
    expect(
      await createTurnIqSkipDisputeCore(
        input,
        noStaff,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(noStaff.createSkipDispute).not.toHaveBeenCalled();

    const own = gateway({
      resolveContext: vi.fn(async () =>
        context({ actorRole: "nail_tech", actorStaffId: IDS.staff }),
      ),
    });
    expect(
      await createTurnIqSkipDisputeCore(
        input,
        own,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toMatchObject({ ok: true, result: { status: "open" } });
    expect(own.createSkipDispute).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: context().salonId,
        assignmentId: IDS.assignment,
        category: "skip_reason",
        actorUserId: IDS.user,
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it("reserves dispute and exception resolution for owner or admin", async () => {
    const tech = gateway({
      resolveContext: vi.fn(async () =>
        context({ actorRole: "nail_tech", actorStaffId: IDS.staff }),
      ),
    });
    const resolveDisputeInput = {
      slug: "salon-a",
      policyVersionId: IDS.policy,
      disputeId: IDS.dispute,
      commandId: IDS.command,
      deviceId: IDS.device,
      localSequence: 4,
      command: {
        type: "resolve_dispute" as const,
        resolution: "resolved" as const,
        reason: "Receipt and event history reviewed with the technician.",
      },
    };
    expect(
      await resolveTurnIqDisputeCore(
        resolveDisputeInput,
        tech,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(tech.resolveDispute).not.toHaveBeenCalled();

    const owner = gateway({
      resolveContext: vi.fn(async () => context({ actorRole: "owner" })),
    });
    expect(
      await applyTurnIqExceptionCommandCore(
        {
          slug: "salon-a",
          policyVersionId: IDS.policy,
          exceptionId: IDS.exception,
          commandId: IDS.command,
          deviceId: IDS.device,
          localSequence: 5,
          command: { type: "acknowledge_exception" },
        },
        owner,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toMatchObject({ ok: true, result: { status: "acknowledged" } });
  });

  it("requires affected-technician consent and desk confirmation for swaps", async () => {
    const tech = gateway({
      resolveContext: vi.fn(async () =>
        context({ actorRole: "nail_tech", actorStaffId: IDS.staff }),
      ),
    });
    const consent = await applyTurnIqSwapCommandCore(
      {
        slug: "salon-a",
        policyVersionId: IDS.policy,
        commandId: IDS.command,
        deviceId: IDS.device,
        localSequence: 7,
        type: "consent_swap",
        swapId: IDS.dispute,
        decision: "accepted",
      },
      tech,
      () => "2026-09-02T18:00:00.000Z",
    );
    expect(consent).toMatchObject({ ok: true });
    expect(tech.applySwap).toHaveBeenCalledWith(
      expect.objectContaining({
        commandType: "consent_swap",
        consentDecision: "accepted",
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );

    expect(
      await applyTurnIqSwapCommandCore(
        {
          slug: "salon-a",
          policyVersionId: IDS.policy,
          commandId: IDS.command,
          deviceId: IDS.device,
          localSequence: 8,
          type: "confirm_swap",
          swapId: IDS.dispute,
        },
        tech,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toEqual({ ok: false, code: "forbidden" });
  });

  it("reserves completed-performer corrections for owner or admin", async () => {
    const input = {
      slug: "salon-a",
      policyVersionId: IDS.policy,
      assignmentId: IDS.assignment,
      actualStaffId: IDS.otherStaff,
      category: "wrong_technician" as const,
      reason: "The service was recorded under the wrong technician.",
      commandId: IDS.command,
      deviceId: IDS.device,
      localSequence: 9,
    };
    const desk = gateway();
    expect(
      await applyTurnIqCorrectionCommandCore(
        input,
        desk,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(desk.applyCorrection).not.toHaveBeenCalled();

    const owner = gateway({
      resolveContext: vi.fn(async () => context({ actorRole: "owner" })),
    });
    expect(
      await applyTurnIqCorrectionCommandCore(
        input,
        owner,
        () => "2026-09-02T18:00:00.000Z",
      ),
    ).toMatchObject({ ok: true, result: { status: "completed" } });
    expect(owner.applyCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentId: IDS.assignment,
        actualStaffId: IDS.otherStaff,
        category: "wrong_technician",
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });
});
