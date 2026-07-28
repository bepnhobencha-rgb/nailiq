import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordAiWorkerHeartbeat } = vi.hoisted(() => ({
  recordAiWorkerHeartbeat: vi.fn(),
}));

vi.mock("@/shared/ai/executionHeartbeat", () => ({
  recordAiWorkerHeartbeat,
}));
vi.mock("server-only", () => ({}));

import { runTrackedCron } from "../cronRunHistory";

describe("runTrackedCron", () => {
  beforeEach(() => {
    recordAiWorkerHeartbeat.mockReset();
    recordAiWorkerHeartbeat.mockResolvedValue(undefined);
  });

  it("persists a fenced start and successful terminal outcome", async () => {
    const handler = vi.fn(async () => new Response("ok", { status: 200 }));

    const response = await runTrackedCron("reminders", handler);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(recordAiWorkerHeartbeat).toHaveBeenCalledTimes(2);
    expect(recordAiWorkerHeartbeat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workerName: "reminders",
        phase: "started",
        summary: { source: "vercel_cron" },
      }),
    );
    const runId = recordAiWorkerHeartbeat.mock.calls[0][0].runId;
    expect(recordAiWorkerHeartbeat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workerName: "reminders",
        runId,
        phase: "succeeded",
        summary: { http_status: 200 },
        error: null,
      }),
    );
  });

  it("does not run work when the start cannot be recorded", async () => {
    recordAiWorkerHeartbeat.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const handler = vi.fn(async () => new Response("ok"));

    const response = await runTrackedCron("wix_sync", handler);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "cron_heartbeat_unavailable",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("records non-success responses as bounded failures", async () => {
    const response = await runTrackedCron(
      "square_sync",
      async () => new Response("provider failed", { status: 502 }),
    );

    expect(response.status).toBe(502);
    expect(recordAiWorkerHeartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "failed",
        summary: { http_status: 502 },
        error: "http_502",
      }),
    );
  });

  it("records handler exceptions and rethrows the original error", async () => {
    const failure = new Error("raw provider detail");

    await expect(
      runTrackedCron("error_triage", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(recordAiWorkerHeartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "failed",
        summary: { outcome: "handler_exception" },
        error: "handler_exception",
      }),
    );
  });

  it("fails honestly when terminal persistence is unavailable", async () => {
    recordAiWorkerHeartbeat
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("database unavailable"));

    const response = await runTrackedCron(
      "spend_sync",
      async () => new Response("ok"),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "cron_heartbeat_unavailable",
    });
  });
});
