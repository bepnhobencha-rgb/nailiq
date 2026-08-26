import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc }),
}));

import { consumeBookingManagementRateLimit } from "../bookingManagementRateLimit";

const TOKEN = "11111111-1111-4111-8111-111111111111";

function request() {
  return new Request(`https://nailiq.test/api/booking/status?token=${TOKEN}`, {
    headers: { "x-forwarded-for": "203.0.113.50" },
  });
}

describe("booking management durable rate limit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists only a hashed IP+token+action key and allows valid status polling", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await consumeBookingManagementRateLimit({
      request: request(), tokenId: TOKEN, action: "status", phase: "inspect",
    })).toBe("allowed");
    const [, args] = rpc.mock.calls[0] as [string, { p_key: string; p_limit: number }];
    expect(args.p_key).not.toContain(TOKEN);
    expect(args.p_key).not.toContain("203.0.113.50");
    expect(args.p_key).toMatch(/^booking-management:[a-f0-9]{64}$/);
    expect(args.p_limit).toBe(120);
  });

  it("distinguishes threshold denial from fail-closed dependency errors", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await consumeBookingManagementRateLimit({
      request: request(), tokenId: TOKEN, action: "confirm", phase: "mutate",
    })).toBe("limited");
    rpc.mockRejectedValueOnce(new Error("db unavailable"));
    expect(await consumeBookingManagementRateLimit({
      request: request(), tokenId: TOKEN, action: "confirm", phase: "inspect",
    })).toBe("unavailable");
  });
});
