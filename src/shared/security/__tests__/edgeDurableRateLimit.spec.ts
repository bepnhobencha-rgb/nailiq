import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeEdgeDurableRateLimits } from "../edgeDurableRateLimit";

describe("Proxy durable rate limiter", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("persists only a hashed IP key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("true", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      consumeEdgeDurableRateLimits({
        scope: "booking-page",
        material: ["203.0.113.9"],
        buckets: [{ name: "minute", limit: 10, windowSeconds: 60 }],
      }),
    ).resolves.toBe("allowed");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(request.body)).not.toContain("203.0.113.9");
    expect(String(request.body)).toMatch(/public-edge:booking-page:minute:[0-9a-f]{64}/);
  });

  it.each([
    [new Response("false", { status: 200 }), "limited"],
    [new Response("null", { status: 200 }), "unavailable"],
    [new Response("down", { status: 503 }), "unavailable"],
  ] as const)("fails closed for edge result %#", async (response, expected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(
      consumeEdgeDurableRateLimits({
        scope: "auth",
        material: ["198.51.100.2"],
        buckets: [{ name: "minute", limit: 1, windowSeconds: 60 }],
      }),
    ).resolves.toBe(expected);
  });
});
