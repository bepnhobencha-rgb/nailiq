import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));

import { surfaceStrategistOperationalNoteApproval } from "@/shared/ai/strategistOperationalNoteApproval";

const NOW = new Date("2026-07-28T05:00:00.000Z");

describe("surfaceStrategistOperationalNoteApproval", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
  });

  it("returns a newly created owner decision with its source identity", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        status: "created",
        approval_request_id: "11111111-1111-4111-8111-111111111111",
        source_action_id: "22222222-2222-4222-8222-222222222222",
      },
      error: null,
    });

    await expect(
      surfaceStrategistOperationalNoteApproval("salon-1", NOW),
    ).resolves.toEqual({
      status: "created",
      approvalRequestId: "11111111-1111-4111-8111-111111111111",
      sourceActionId: "22222222-2222-4222-8222-222222222222",
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "surface_strategist_operational_note_approval",
      {
        p_salon_id: "salon-1",
        p_now: NOW.toISOString(),
      },
    );
  });

  it.each(["existing", "no_candidate"] as const)(
    "reports %s without inventing a new approval",
    async (status) => {
      mocks.rpc.mockResolvedValue({
        data:
          status === "existing"
            ? {
                status,
                approval_request_id:
                  "11111111-1111-4111-8111-111111111111",
                source_action_id:
                  "22222222-2222-4222-8222-222222222222",
              }
            : { status },
        error: null,
      });

      const result = await surfaceStrategistOperationalNoteApproval(
        "salon-1",
        NOW,
      );

      expect(result.status).toBe(status);
    },
  );

  it("fails honestly on an RPC error or malformed response", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "database unavailable" },
    });
    await expect(
      surfaceStrategistOperationalNoteApproval("salon-1", NOW),
    ).rejects.toThrow("database unavailable");

    mocks.rpc.mockResolvedValueOnce({
      data: { status: "created" },
      error: null,
    });
    await expect(
      surfaceStrategistOperationalNoteApproval("salon-1", NOW),
    ).rejects.toThrow("invalid_strategist_operational_note_result");
  });
});
