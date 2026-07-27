import { describe, expect, it } from "vitest";

import {
  canRetryExecution,
  initialExecutionStatus,
  nextRetryAt,
} from "@/shared/ai/executionPolicy";

describe("executionPolicy", () => {
  it("waits for input when recipient selection is required", () => {
    expect(initialExecutionStatus({ recipient_selection_required: true })).toBe(
      "waiting_input",
    );
    expect(initialExecutionStatus({ recipient_selection_required: false })).toBe(
      "queued",
    );
  });

  it("only retries due jobs below their attempt limit", () => {
    const now = new Date("2026-07-27T08:00:00.000Z");
    expect(
      canRetryExecution({
        status: "failed",
        attemptCount: 2,
        maxAttempts: 3,
        availableAt: "2026-07-27T07:59:00.000Z",
        now,
      }),
    ).toBe(true);
    expect(
      canRetryExecution({
        status: "failed",
        attemptCount: 3,
        maxAttempts: 3,
        availableAt: "2026-07-27T07:59:00.000Z",
        now,
      }),
    ).toBe(false);
    expect(
      canRetryExecution({
        status: "waiting_input",
        attemptCount: 0,
        maxAttempts: 3,
        availableAt: "2026-07-27T07:59:00.000Z",
        now,
      }),
    ).toBe(false);
  });

  it("uses bounded exponential retry delays", () => {
    const now = new Date("2026-07-27T08:00:00.000Z");
    expect(nextRetryAt(1, now)).toBe("2026-07-27T08:05:00.000Z");
    expect(nextRetryAt(3, now)).toBe("2026-07-27T08:20:00.000Z");
    expect(nextRetryAt(5, now)).toBe("2026-07-27T09:00:00.000Z");
  });
});
