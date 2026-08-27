import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(),
  ensure: vi.fn(),
  overRate: vi.fn(),
  recordPending: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/security/sameOriginMutation", () => ({
  isSameOriginMutation: () => true,
}));
vi.mock("@/shared/booking/bookingManagementCapabilities", () => ({
  exchangePublicBookingCardManagementCapability: mocks.exchange,
}));
vi.mock("@/shared/noshow/ensureNoShowCardRequirement", () => ({
  ensureNoShowCardRequirement: mocks.ensure,
}));
vi.mock("@/shared/lib/inAppRateLimit", () => ({
  clientIp: () => "127.0.0.1",
  durableRateLimitKey: (...parts: string[]) => parts.join(":"),
  isOverRateLimit: mocks.overRate,
}));
vi.mock("@/shared/booking/bookingCardContinuation", () => ({
  recordCommittedBookingCardPending: mocks.recordPending,
}));

import { POST } from "@/app/api/booking/card-capability/route";

describe("POST /api/booking/card-capability in V1", () => {
  it("permits the narrow no-show card-on-file capability", async () => {
    mocks.overRate.mockResolvedValue(false);
    mocks.exchange.mockResolvedValue({
      ok: true,
      capability: { tokenId: "44444444-4444-4444-8444-444444444444" },
    });
    mocks.ensure.mockResolvedValue({ required: true, feeCents: 2000 });
    mocks.recordPending.mockResolvedValue(true);
    const response = await POST(new NextRequest(
      "https://nailiq.test/api/booking/card-capability",
      {
        method: "POST",
        headers: {
          Origin: "https://nailiq.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          salonId: "11111111-1111-4111-8111-111111111111",
          bookingId: "22222222-2222-4222-8222-222222222222",
          idempotencyKey: "33333333-3333-4333-8333-333333333333",
          pricingFingerprint: "a".repeat(64),
        }),
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      required: true,
      token: "44444444-4444-4444-8444-444444444444",
    });
    expect(mocks.overRate).toHaveBeenCalledOnce();
    expect(mocks.exchange).toHaveBeenCalledOnce();
    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.recordPending).toHaveBeenCalledWith(expect.objectContaining({
      scope: "individual",
      stage: "customer_action",
      reason: "card_required",
    }));
  });
});
