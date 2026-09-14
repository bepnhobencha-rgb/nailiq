import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));

import { loadWaitlistDeliveryTruth } from "../loadWaitlistDeliveryTruth";

const SALON = "11111111-1111-4111-8111-111111111111";
const ENTRY = "22222222-2222-4222-8222-222222222222";

describe("loadWaitlistDeliveryTruth", () => {
  beforeEach(() => mocks.rpc.mockReset());

  it("loads the tenant-scoped terminal projection without provider material", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          waitlist_entry_id: ENTRY,
          offer_epoch: 4,
          channel: "sms",
          status: "delivered",
          error_code: null,
          updated_at: "2026-09-14T15:00:00.000Z",
        },
      ],
      error: null,
    });

    const result = await loadWaitlistDeliveryTruth({
      salonId: SALON,
      entryIds: [ENTRY, ENTRY],
      knownEpochs: new Map([[ENTRY, 4]]),
    });

    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "load_waitlist_offer_delivery_truth",
      { p_salon_id: SALON, p_waitlist_entry_ids: [ENTRY] },
    );
    expect(result.available).toBe(true);
    expect(result.truthByEntry.get(ENTRY)?.sms.status).toBe("delivered");
  });

  it("fails closed when the privileged projection is unavailable", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "unavailable" } });

    const result = await loadWaitlistDeliveryTruth({
      salonId: SALON,
      entryIds: [ENTRY],
      knownEpochs: new Map([[ENTRY, 4]]),
    });

    expect(result.available).toBe(false);
    expect(result.truthByEntry.get(ENTRY)?.sms.status).toBe("unavailable");
    expect(result.truthByEntry.get(ENTRY)?.email.status).toBe("unavailable");
  });
});
