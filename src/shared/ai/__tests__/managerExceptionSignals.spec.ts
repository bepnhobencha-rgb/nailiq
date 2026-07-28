import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc }),
}));

import {
  buildManagerExceptionSignals,
  syncManagerExceptionSignals,
} from "@/shared/ai/managerExceptionSignals";

describe("AI Manager operational exception signals", () => {
  beforeEach(() => rpc.mockReset());

  it("keeps only bounded deterministic agent outcomes", () => {
    expect(
      buildManagerExceptionSignals({
        salon: "tech-nails",
        watchdog: "failed",
        strategist_note: "ok",
        invalid: "skipped",
        "bad agent": "failed",
      }),
    ).toEqual([
      { agent: "watchdog", status: "failed" },
      { agent: "strategist_note", status: "ok" },
    ]);
  });

  it("sends one PII-free batch scoped to the salon", async () => {
    rpc.mockResolvedValue({ data: { processed: 2 }, error: null });
    const now = new Date("2026-07-28T11:30:00.000Z");

    await syncManagerExceptionSignals(
      "22222222-2222-4222-8222-222222222222",
      {
        salon: "customer-facing-slug-is-not-sent",
        watchdog: "failed",
        strategist_note: "ok",
      },
      now,
    );

    expect(rpc).toHaveBeenCalledWith(
      "sync_ai_manager_operational_exceptions",
      {
        p_salon_id: "22222222-2222-4222-8222-222222222222",
        p_signals: [
          { agent: "watchdog", status: "failed" },
          { agent: "strategist_note", status: "ok" },
        ],
        p_now: now.toISOString(),
      },
    );
  });

  it("fails honestly when durable exception sync is unavailable", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "provider detail" },
    });
    await expect(
      syncManagerExceptionSignals("salon-id", { watchdog: "failed" }),
    ).rejects.toThrow("provider detail");
  });
});
