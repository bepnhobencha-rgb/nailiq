import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createServiceRoleClient,
  recordAiWorkerHeartbeat,
  runWatchdog,
  select,
  syncManagerExceptionSignals,
  surfaceStrategistOperationalNoteApproval,
} = vi.hoisted(() => ({
    createServiceRoleClient: vi.fn(),
    recordAiWorkerHeartbeat: vi.fn(),
    runWatchdog: vi.fn(),
    select: vi.fn(),
    syncManagerExceptionSignals: vi.fn(),
    surfaceStrategistOperationalNoteApproval: vi.fn(),
  }));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient,
}));
vi.mock("@/shared/ai/executionHeartbeat", () => ({
  recordAiWorkerHeartbeat,
}));
vi.mock("@/shared/lib/salonTime", () => ({
  salonNowMinutes: () => 0,
}));
vi.mock("@/shared/watchdog/agentWatchdog", () => ({
  runWatchdog,
}));
vi.mock("@/shared/ai/strategistOperationalNoteApproval", () => ({
  surfaceStrategistOperationalNoteApproval,
}));
vi.mock("@/shared/ai/managerExceptionSignals", () => ({
  syncManagerExceptionSignals,
}));

import { GET } from "./route";

describe("AI manager cron route", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    select.mockReset();
    createServiceRoleClient.mockReset();
    recordAiWorkerHeartbeat.mockReset();
    runWatchdog.mockReset();
    surfaceStrategistOperationalNoteApproval.mockReset();
    syncManagerExceptionSignals.mockReset();
    recordAiWorkerHeartbeat.mockResolvedValue(undefined);
    surfaceStrategistOperationalNoteApproval.mockResolvedValue({
      status: "no_candidate",
    });
    syncManagerExceptionSignals.mockResolvedValue(undefined);
    createServiceRoleClient.mockReturnValue({
      from: vi.fn(() => ({ select })),
    });
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it("fails closed when the cron secret is missing", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(
      new Request("https://nailiq.ca/api/cron/manager"),
    );
    expect(response.status).toBe(503);
    expect(recordAiWorkerHeartbeat).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token without recording a heartbeat", async () => {
    process.env.CRON_SECRET = "correct-secret";
    const response = await GET(
      new Request("https://nailiq.ca/api/cron/manager", {
        headers: { authorization: "Bearer wrong-secret" },
      }),
    );
    expect(response.status).toBe(401);
    expect(recordAiWorkerHeartbeat).not.toHaveBeenCalled();
  });

  it("records a successful idle run", async () => {
    process.env.CRON_SECRET = "correct-secret";
    select.mockResolvedValue({ data: [], error: null });
    const response = await GET(
      new Request("https://nailiq.ca/api/cron/manager", {
        headers: { authorization: "Bearer correct-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, salons: 0 });
    expect(recordAiWorkerHeartbeat).toHaveBeenCalledTimes(2);
    expect(recordAiWorkerHeartbeat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workerName: "ai_manager",
        phase: "started",
      }),
    );
    expect(recordAiWorkerHeartbeat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workerName: "ai_manager",
        phase: "succeeded",
        summary: expect.objectContaining({ salons: 0, agent_failures: 0 }),
      }),
    );
  });

  it("records a failed run when salons cannot be loaded", async () => {
    process.env.CRON_SECRET = "correct-secret";
    select.mockResolvedValue({
      data: null,
      error: { message: "database unavailable" },
    });
    const response = await GET(
      new Request("https://nailiq.ca/api/cron/manager", {
        headers: { authorization: "Bearer correct-secret" },
      }),
    );
    expect(response.status).toBe(500);
    expect(recordAiWorkerHeartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workerName: "ai_manager",
        phase: "failed",
        error: "salon_load_failed",
      }),
    );
  });

  it("fails honestly when durable exception synchronization fails", async () => {
    process.env.CRON_SECRET = "correct-secret";
    select.mockResolvedValue({
      data: [
        {
          id: "salon-1",
          slug: "alpha",
          feature_flags: {},
          timezone: "America/Vancouver",
        },
      ],
      error: null,
    });
    syncManagerExceptionSignals.mockRejectedValue(
      new Error("exception RPC unavailable"),
    );

    const response = await GET(
      new Request("https://nailiq.ca/api/cron/manager", {
        headers: { authorization: "Bearer correct-secret" },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      summary: {
        agent_failures: 1,
        failed_agents: ["alpha:exception_sync"],
      },
      results: [
        {
          salon: "alpha",
          strategist_note: "ok",
          exception_sync: "failed",
        },
      ],
    });
  });

  it("does not run agents invisibly when the heartbeat cannot start", async () => {
    process.env.CRON_SECRET = "correct-secret";
    recordAiWorkerHeartbeat.mockRejectedValueOnce(
      new Error("heartbeat unavailable"),
    );
    const response = await GET(
      new Request("https://nailiq.ca/api/cron/manager", {
        headers: { authorization: "Bearer correct-secret" },
      }),
    );
    expect(response.status).toBe(500);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns a failed run and stores no raw agent error body", async () => {
    process.env.CRON_SECRET = "correct-secret";
    select.mockResolvedValue({
      data: [
        {
          id: "salon-1",
          slug: "alpha",
          feature_flags: { ai_watchdog: true },
          timezone: "America/Vancouver",
        },
      ],
      error: null,
    });
    runWatchdog.mockRejectedValue(
      new Error("provider failed with sensitive details"),
    );

    const response = await GET(
      new Request("https://nailiq.ca/api/cron/manager", {
        headers: { authorization: "Bearer correct-secret" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      ok: false,
      summary: {
        salons: 1,
        agent_runs: 2,
        agent_failures: 1,
        failed_agents: ["alpha:watchdog"],
      },
      results: [
        { salon: "alpha", strategist_note: "ok", watchdog: "failed" },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("sensitive details");
    expect(recordAiWorkerHeartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workerName: "ai_manager",
        phase: "failed",
        error: "manager_agent_failures",
      }),
    );
    expect(syncManagerExceptionSignals).toHaveBeenCalledWith(
      "salon-1",
      {
        salon: "alpha",
        strategist_note: "ok",
        watchdog: "failed",
      },
    );
  });

  it("fails honestly when structural recommendations cannot be surfaced", async () => {
    process.env.CRON_SECRET = "correct-secret";
    select.mockResolvedValue({
      data: [
        {
          id: "salon-1",
          slug: "alpha",
          feature_flags: {},
          timezone: "America/Vancouver",
        },
      ],
      error: null,
    });
    surfaceStrategistOperationalNoteApproval.mockRejectedValue(
      new Error("proposal RPC unavailable"),
    );

    const response = await GET(
      new Request("https://nailiq.ca/api/cron/manager", {
        headers: { authorization: "Bearer correct-secret" },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      summary: {
        salons: 1,
        agent_runs: 1,
        agent_failures: 1,
        failed_agents: ["alpha:strategist_note"],
      },
      results: [{ salon: "alpha", strategist_note: "failed" }],
    });
    expect(recordAiWorkerHeartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "failed",
        error: "manager_agent_failures",
      }),
    );
  });
});
