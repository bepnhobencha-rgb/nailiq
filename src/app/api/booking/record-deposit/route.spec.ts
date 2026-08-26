import { beforeEach, describe, expect, it, vi } from "vitest";

const privileged = vi.hoisted(() => {
  const from = vi.fn();
  const rpc = vi.fn();
  const createServiceRoleClient = vi.fn(() => ({ from, rpc }));
  const paymentIntentsRetrieve = vi.fn();
  const getStripeClient = vi.fn(() => ({
    paymentIntents: { retrieve: paymentIntentsRetrieve },
  }));
  return {
    createServiceRoleClient,
    from,
    getStripeClient,
    paymentIntentsRetrieve,
    rpc,
  };
});

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: privileged.createServiceRoleClient,
}));

vi.mock("@/shared/lib/stripe", () => ({
  getStripeClient: privileged.getStripeClient,
}));

import { POST } from "./route";

describe("retired /api/booking/record-deposit boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a generic no-store 410 without reading or writing privileged state", async () => {
    const request = new Request("https://nailiq.example/api/booking/record-deposit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookingId: "caller-selected-booking",
        paymentIntentId: "pi_caller_selected",
        connectedAccountId: "acct_caller_selected",
      }),
    });

    const response = await POST();

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ ok: false, error: "gone" });
    expect(request.bodyUsed).toBe(false);
    expect(privileged.createServiceRoleClient).not.toHaveBeenCalled();
    expect(privileged.from).not.toHaveBeenCalled();
    expect(privileged.rpc).not.toHaveBeenCalled();
    expect(privileged.getStripeClient).not.toHaveBeenCalled();
    expect(privileged.paymentIntentsRetrieve).not.toHaveBeenCalled();
  });
});
