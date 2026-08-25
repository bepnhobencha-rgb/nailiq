import { describe, expect, it, vi } from "vitest";

import { loadPublicBookingSnapshot } from "../loadBookingServices";

function clientWith(result: { data: unknown; error: unknown }) {
  return {
    rpc: vi.fn().mockResolvedValue(result),
  } as never;
}

describe("loadPublicBookingSnapshot", () => {
  it("accepts the complete tenant-safe snapshot contract", async () => {
    const client = clientWith({
      data: {
        salon: { id: "salon-1", slug: "qa-salon" },
        services: [],
        staff: [],
        capabilities: [],
        promotions: [],
        promotion_services: [],
        combos: [],
        resources: [],
      },
      error: null,
    });

    const result = await loadPublicBookingSnapshot(client, "qa-salon");

    expect(result.error).toBeNull();
    expect(result.snapshot?.salon).toEqual({
      id: "salon-1",
      slug: "qa-salon",
    });
    expect((client as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      "load_public_booking_snapshot",
      { p_slug: "qa-salon" },
    );
  });

  it("keeps a genuine missing salon distinct from an RPC failure", async () => {
    await expect(
      loadPublicBookingSnapshot(clientWith({ data: null, error: null }), "missing"),
    ).resolves.toEqual({ snapshot: null, error: null });

    const failed = await loadPublicBookingSnapshot(
      clientWith({
        data: null,
        error: { message: "database unavailable", code: "08006" },
      }),
      "live-salon",
    );
    expect(failed).toEqual({
      snapshot: null,
      error: { message: "database unavailable", code: "08006" },
    });
  });

  it("fails closed when any catalog array is omitted", async () => {
    const result = await loadPublicBookingSnapshot(
      clientWith({
        data: {
          salon: { id: "salon-1", slug: "qa-salon" },
          services: [],
          staff: [],
          capabilities: [],
          promotions: [],
          promotion_services: [],
          combos: [],
        },
        error: null,
      }),
      "qa-salon",
    );

    expect(result.snapshot).toBeNull();
    expect(result.error?.message).toContain("catalog arrays");
  });
});
