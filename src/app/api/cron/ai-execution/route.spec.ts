import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { processExecutionQueue } = vi.hoisted(() => ({
  processExecutionQueue: vi.fn(),
}));

vi.mock("@/shared/ai/executionWorker", () => ({
  processExecutionQueue,
}));

import { GET } from "./route";

describe("AI execution cron route", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    processExecutionQueue.mockReset();
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it("fails closed when the cron secret is not configured", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(
      new Request("https://nailiq.ca/api/cron/ai-execution"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "cron_secret_not_configured",
    });
    expect(processExecutionQueue).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token", async () => {
    process.env.CRON_SECRET = "correct-secret";
    const response = await GET(
      new Request("https://nailiq.ca/api/cron/ai-execution", {
        headers: { authorization: "Bearer wrong-secret" },
      }),
    );
    expect(response.status).toBe(401);
    expect(processExecutionQueue).not.toHaveBeenCalled();
  });

  it("runs a bounded batch for an authorized cron request", async () => {
    process.env.CRON_SECRET = "correct-secret";
    processExecutionQueue.mockResolvedValue({
      inspected: 1,
      recovered: 0,
      claimed: 1,
      succeeded: 1,
      failed: 0,
      waitingInput: 0,
      canceled: 0,
      outcomes: [
        { jobId: "job-1", status: "succeeded", attempted: true },
      ],
    });
    const response = await GET(
      new Request("https://nailiq.ca/api/cron/ai-execution", {
        headers: { authorization: "Bearer correct-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(processExecutionQueue).toHaveBeenCalledWith({ limit: 10 });
    expect(await response.json()).toMatchObject({
      ok: true,
      claimed: 1,
      succeeded: 1,
    });
  });
});
