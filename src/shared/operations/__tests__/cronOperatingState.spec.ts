import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import {
  CRON_ROUTE_CONTRACTS,
  deriveCronRouteHealth,
  loadCronOperatingState,
} from "../cronOperatingState";

const NOW = new Date("2026-07-28T15:00:00.000Z");
const reminders = CRON_ROUTE_CONTRACTS.find(
  (contract) => contract.workerName === "reminders",
)!;

function heartbeat(
  status: "unknown" | "running" | "succeeded" | "failed",
  startedAt = "2026-07-28T14:50:00.000Z",
) {
  return {
    worker_name: "reminders" as const,
    run_id: "00000000-0000-0000-0000-000000000001",
    status,
    started_at: startedAt,
    completed_at:
      status === "running" || status === "unknown"
        ? null
        : "2026-07-28T14:50:10.000Z",
    succeeded_at:
      status === "succeeded" ? "2026-07-28T14:50:10.000Z" : null,
    last_error: status === "failed" ? "http_500" : null,
  };
}

describe("cron operating state", () => {
  it("defines one freshness contract for every scheduled route", () => {
    expect(CRON_ROUTE_CONTRACTS).toHaveLength(20);
    expect(new Set(CRON_ROUTE_CONTRACTS.map((item) => item.workerName)).size).toBe(
      20,
    );
  });

  it("stays in exact parity with the deployed Vercel cron manifest", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "vercel.json"), "utf8"),
    ) as { crons: Array<{ path: string }> };
    const manifestWorkers = manifest.crons.map(({ path }) => {
      const route = path.replace("/api/cron/", "").replaceAll("-", "_");
      return route === "manager" ? "ai_manager" : route;
    });

    expect(manifestWorkers.sort()).toEqual(
      CRON_ROUTE_CONTRACTS.map((item) => item.workerName).sort(),
    );
  });

  it("schedules both payment workers every minute with a five-minute freshness fence", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "vercel.json"), "utf8"),
    ) as { crons: Array<{ path: string; schedule: string }> };

    for (const [workerName, path] of [
      ["deposit_compensation", "/api/cron/deposit-compensation"],
      ["payment_reconciliation", "/api/cron/payment-reconciliation"],
    ] as const) {
      expect(manifest.crons.find((item) => item.path === path)).toEqual({
        path,
        schedule: "*/1 * * * *",
      });
      expect(
        CRON_ROUTE_CONTRACTS.find((item) => item.workerName === workerName),
      ).toMatchObject({ schedule: "Every minute", staleAfterMs: 5 * 60_000 });
    }
  });

  it("distinguishes missing, running, failed, stale, and healthy workers", () => {
    expect(deriveCronRouteHealth(reminders, null, NOW).status).toBe("missing");
    expect(
      deriveCronRouteHealth(reminders, heartbeat("running"), NOW).status,
    ).toBe("running");
    expect(
      deriveCronRouteHealth(reminders, heartbeat("failed"), NOW).status,
    ).toBe("failed");
    expect(
      deriveCronRouteHealth(
        reminders,
        heartbeat("succeeded", "2026-07-28T13:00:00.000Z"),
        NOW,
      ).status,
    ).toBe("stale");
    expect(
      deriveCronRouteHealth(reminders, heartbeat("succeeded"), NOW).status,
    ).toBe("healthy");
  });

  it("does not page on a worker before its first scheduled observation is due", () => {
    const daily = CRON_ROUTE_CONTRACTS.find(
      (contract) => contract.workerName === "minh_learn",
    )!;

    expect(
      deriveCronRouteHealth(
        daily,
        null,
        NOW,
        new Date("2026-07-28T14:00:00.000Z"),
      ).status,
    ).toBe("pending");
    expect(
      deriveCronRouteHealth(
        daily,
        null,
        NOW,
        new Date("2026-07-26T08:00:00.000Z"),
      ).status,
    ).toBe("missing");
  });

  it("never applies first-run grace to a recorded failure", () => {
    expect(
      deriveCronRouteHealth(
        reminders,
        heartbeat("failed"),
        NOW,
        new Date("2026-07-28T14:45:00.000Z"),
      ).status,
    ).toBe("failed");
  });

  it("derives the monitoring start from real recorded worker history", async () => {
    mocks.createServiceRoleClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({
          data: [heartbeat("succeeded", "2026-07-28T14:50:00.000Z")],
          error: null,
        }),
      }),
    });

    const state = await loadCronOperatingState(NOW);
    expect(
      state.find((worker) => worker.workerName === "minh_learn")?.status,
    ).toBe("pending");
    expect(
      state.find((worker) => worker.workerName === "reminders")?.status,
    ).toBe("healthy");
  });

  it("fails stale on malformed timestamps", () => {
    expect(
      deriveCronRouteHealth(
        reminders,
        heartbeat("succeeded", "not-a-date"),
        NOW,
      ).status,
    ).toBe("stale");
  });
});
