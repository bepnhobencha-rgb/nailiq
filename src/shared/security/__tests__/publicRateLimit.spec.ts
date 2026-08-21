import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), headers: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));

import {
  consumeDurableRateLimitBuckets,
  consumePublicRequestRateLimit,
  consumePublicServerActionRateLimit,
} from "../publicServerActionRateLimit";

describe("public durable rate limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.headers.mockResolvedValue(
      new Headers({ "x-forwarded-for": "203.0.113.42, 10.0.0.1" }),
    );
  });

  it("hashes raw IP and identity material before persistence", async () => {
    await expect(
      consumePublicServerActionRateLimit({
        scope: "auth-password",
        identity: "Owner@Example.com",
        ipLimits: [[2, 60]],
        identityLimits: [[2, 60]],
      }),
    ).resolves.toBe("allowed");
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(mocks.rpc.mock.calls);
    expect(serialized).not.toContain("203.0.113.42");
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).toMatch(/public:auth-password:(?:ip|identity)-0:[0-9a-f]{64}/);
  });

  it.each([
    [{ data: false, error: null }, "limited"],
    [{ data: null, error: null }, "unavailable"],
    [{ data: true, error: { message: "down" } }, "unavailable"],
  ] as const)("fails closed for limiter result %#", async (rpcResult, expected) => {
    mocks.rpc.mockResolvedValue(rpcResult);
    await expect(
      consumeDurableRateLimitBuckets("provider", [
        { name: "ip", material: ["secret"], limit: 1, windowSeconds: 60 },
      ]),
    ).resolves.toBe(expected);
  });

  it("hashes route IP and customer identity material before persistence", async () => {
    const request = new Request("https://nailiq.test/api/customer/profile-verified", {
      headers: { "x-forwarded-for": "198.51.100.4" },
    });
    await expect(
      consumePublicRequestRateLimit({
        request,
        scope: "customer-profile",
        identity: ["SALON-ID", "+1 604 555 0199"],
        ipLimits: [[4, 60]],
        identityLimits: [[2, 600]],
      }),
    ).resolves.toBe("allowed");

    const serialized = JSON.stringify(mocks.rpc.mock.calls);
    expect(serialized).not.toContain("198.51.100.4");
    expect(serialized).not.toContain("604 555 0199");
    expect(serialized).toContain("public:customer-profile:identity-0:");
  });
});
