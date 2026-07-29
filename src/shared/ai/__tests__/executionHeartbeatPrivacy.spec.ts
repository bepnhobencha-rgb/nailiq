import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc }),
}));

import { recordAiWorkerHeartbeat } from "@/shared/ai/executionHeartbeat";

describe("AI worker heartbeat privacy", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: true, error: null });
  });

  it("never passes raw dependency errors to the heartbeat ledger", async () => {
    await recordAiWorkerHeartbeat({
      workerName: "ai_manager",
      runId: "11111111-1111-4111-8111-111111111111",
      phase: "failed",
      now: new Date("2026-07-29T20:00:00.000Z"),
      error: "database password=secret customer=someone@example.com",
    });

    expect(rpc).toHaveBeenCalledWith(
      "record_ai_worker_heartbeat",
      expect.objectContaining({ p_error: "execution_worker_failed" }),
    );
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("someone@example.com");
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("password=secret");
  });
});
