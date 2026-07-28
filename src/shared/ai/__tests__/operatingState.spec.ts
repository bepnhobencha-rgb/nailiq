import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { MinhLesson } from "@/shared/ai/lessons";
import {
  deriveExecutionWorkerHealth,
  deriveAiOperatingHealth,
  deriveLearnedAiControls,
} from "@/shared/ai/operatingState";
import type { ExecutionWorkerHeartbeatRow } from "@/shared/ai/executionHeartbeat";

const NOW = new Date("2026-07-27T18:00:00.000Z");

function lesson(overrides: Partial<MinhLesson> = {}): MinhLesson {
  return {
    id: "lesson-1",
    salonId: "salon-1",
    scope: "policy",
    condition: {
      action_type: "bulk_message",
      proposal_source: "weekly_strategist",
      suppress_until: "2026-08-24T18:00:00.000Z",
    },
    rule: "proposal_cooldown",
    source: "owner_preference:bulk_message:weekly_strategist",
    confidence: 0.8,
    ...overrides,
  };
}

describe("AI operating state", () => {
  it("prioritizes failures and stalled workers over lesser queue states", () => {
    expect(
      deriveAiOperatingHealth({
        queued: 2,
        waitingInput: 3,
        running: 1,
        failed: 1,
        stalled: 1,
      }),
    ).toEqual({
      tone: "issue",
      queued: 2,
      waitingInput: 3,
      running: 1,
      failed: 1,
      stalled: 1,
      activeWork: 3,
      needsAttention: 5,
      workerIssue: false,
    });
  });

  it("reports a failed, stale, or missing scheduler as an operating issue", () => {
    const failedWorker = {
      status: "failed" as const,
      lastStartedAt: "2026-07-27T17:58:00.000Z",
      lastCompletedAt: "2026-07-27T17:58:01.000Z",
      lastSucceededAt: "2026-07-27T17:50:00.000Z",
      lastError: "claim_failed",
    };
    expect(
      deriveAiOperatingHealth(
        {
          queued: 0,
          waitingInput: 0,
          running: 0,
          failed: 0,
          stalled: 0,
        },
        failedWorker,
      ),
    ).toMatchObject({
      tone: "issue",
      workerIssue: true,
      needsAttention: 1,
    });

    expect(
      deriveAiOperatingHealth(
        {
          queued: 0,
          waitingInput: 0,
          running: 0,
          failed: 0,
          stalled: 0,
        },
        { ...failedWorker, status: "healthy", lastError: null },
        failedWorker,
      ),
    ).toMatchObject({
      tone: "issue",
      workerIssue: true,
      needsAttention: 1,
    });
  });

  it("derives worker freshness from the persisted scheduler heartbeat", () => {
    const heartbeat: ExecutionWorkerHeartbeatRow = {
      worker_name: "ai_execution",
      run_id: "run-1",
      status: "succeeded",
      started_at: "2026-07-27T17:56:00.000Z",
      completed_at: "2026-07-27T17:56:01.000Z",
      succeeded_at: "2026-07-27T17:56:01.000Z",
      last_error: null,
      summary: { claimed: 0 },
      updated_at: "2026-07-27T17:56:01.000Z",
    };

    expect(deriveExecutionWorkerHealth(heartbeat, NOW).status).toBe("healthy");
    expect(
      deriveExecutionWorkerHealth(
        { ...heartbeat, status: "running" },
        NOW,
      ).status,
    ).toBe("running");
    expect(
      deriveExecutionWorkerHealth(
        { ...heartbeat, started_at: "2026-07-27T17:44:59.000Z" },
        NOW,
      ).status,
    ).toBe("stale");
    expect(deriveExecutionWorkerHealth(null, NOW).status).toBe("unknown");
    expect(
      deriveExecutionWorkerHealth(
        {
          ...heartbeat,
          worker_name: "ai_manager",
          started_at: "2026-07-27T16:01:00.000Z",
        },
        NOW,
        2 * 60 * 60_000,
      ).status,
    ).toBe("healthy");
    expect(
      deriveExecutionWorkerHealth(
        {
          ...heartbeat,
          worker_name: "ai_manager",
          started_at: "2026-07-27T15:59:59.000Z",
        },
        NOW,
        2 * 60 * 60_000,
      ).status,
    ).toBe("stale");
  });

  it("distinguishes owner input, active work, and an idle healthy queue", () => {
    expect(
      deriveAiOperatingHealth({
        queued: 0,
        waitingInput: 1,
        running: 0,
        failed: 0,
        stalled: 0,
      }).tone,
    ).toBe("attention");
    expect(
      deriveAiOperatingHealth({
        queued: 1,
        waitingInput: 0,
        running: 1,
        failed: 0,
        stalled: 0,
      }).tone,
    ).toBe("active");
    expect(
      deriveAiOperatingHealth({
        queued: 0,
        waitingInput: 0,
        running: 0,
        failed: 0,
        stalled: 0,
      }).tone,
    ).toBe("healthy");
  });

  it("shows only live controls learned from the current salon", () => {
    const controls = deriveLearnedAiControls(
      "salon-1",
      [
        lesson(),
        lesson({
          id: "other-salon",
          salonId: "salon-2",
          condition: {
            action_type: "bulk_message",
            suppress_until: "2026-09-01T00:00:00.000Z",
          },
        }),
        lesson({
          id: "global",
          salonId: null,
          scope: "segment",
          condition: { agent: "winback" },
          rule: "cap_multiplier:0.5",
        }),
        lesson({
          id: "pace",
          scope: "segment",
          condition: { agent: "rebook" },
          rule: "cap_multiplier:0.5",
        }),
      ],
      NOW,
    );

    expect(controls).toEqual([
      {
        kind: "proposal_cooldown",
        actionType: "bulk_message",
        proposalSource: "weekly_strategist",
        suppressUntil: "2026-08-24T18:00:00.000Z",
      },
      { kind: "reduced_pace", agent: "rebook", capMultiplier: 0.5 },
    ]);
  });

  it("does not present expired or invalid adaptations as active", () => {
    expect(
      deriveLearnedAiControls(
        "salon-1",
        [
          lesson({
            condition: {
              action_type: "bulk_message",
              suppress_until: "2026-07-27T17:59:59.000Z",
            },
          }),
          lesson({
            scope: "segment",
            condition: { agent: "winback" },
            rule: "cap_multiplier:1",
          }),
        ],
        NOW,
      ),
    ).toEqual([]);
  });
});
