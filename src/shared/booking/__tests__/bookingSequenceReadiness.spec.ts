import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));

import {
  loadPublicBookingSequenceReadiness,
  parseBookingSequenceReadiness,
} from "@/shared/booking/bookingSequenceReadiness";

const salonId = "11111111-1111-4111-8111-111111111111";
const ready = {
  success: true,
  code: "loaded",
  contract_version: 1,
  schedule_model: "segments_v1",
  platform_enabled: true,
  salon_enabled: true,
  qa_allowlisted: true,
  catalog_ready: true,
  capacity_contract_ready: true,
  ready: true,
};

describe("booking sequence readiness", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts only a self-consistent v1 readiness proof", () => {
    expect(parseBookingSequenceReadiness(ready)).toMatchObject({ ready: true });
    expect(
      parseBookingSequenceReadiness({ ...ready, salon_enabled: false }),
    ).toBeNull();
    expect(parseBookingSequenceReadiness({ ...ready, extra: true })).toBeNull();
  });

  it("calls the service-only loader and returns ready only for exact proof", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: ready, error: null });
    await expect(loadPublicBookingSequenceReadiness(salonId)).resolves.toMatchObject({
      ok: true,
      readiness: { ready: true },
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "load_public_booking_sequence_readiness",
      { p_salon_id: salonId },
    );

    mocks.rpc.mockResolvedValueOnce({
      data: { ...ready, catalog_ready: false, ready: false },
      error: null,
    });
    await expect(loadPublicBookingSequenceReadiness(salonId)).resolves.toMatchObject({
      ok: false,
      code: "not_ready",
      readiness: { catalogReady: false, ready: false },
    });
  });

  it("fails closed on invalid IDs, query errors, malformed rows, and throws", async () => {
    await expect(loadPublicBookingSequenceReadiness("bad")).resolves.toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();

    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    await expect(loadPublicBookingSequenceReadiness(salonId)).resolves.toEqual({
      ok: false,
      code: "unavailable",
    });
    mocks.rpc.mockResolvedValueOnce({ data: { ...ready, ready: "yes" }, error: null });
    await expect(loadPublicBookingSequenceReadiness(salonId)).resolves.toEqual({
      ok: false,
      code: "unavailable",
    });
    mocks.rpc.mockRejectedValueOnce(new Error("down"));
    await expect(loadPublicBookingSequenceReadiness(salonId)).resolves.toEqual({
      ok: false,
      code: "unavailable",
    });
  });
});
