import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeEdgeDurableRateLimits } from "../edgeDurableRateLimit";

describe("Proxy durable rate limiter", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_INTERNAL_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret";
  });
  afterEach(() => {
    delete process.env.SUPABASE_INTERNAL_URL;
    vi.unstubAllGlobals();
  });

  it("prefers the server-only Supabase origin when configured", async () => {
    process.env.SUPABASE_INTERNAL_URL = "http://127.0.0.1:54321/";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("true", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      consumeEdgeDurableRateLimits({
        scope: "booking-page",
        material: ["203.0.113.10"],
        buckets: [{ name: "minute", limit: 10, windowSeconds: 60 }],
      }),
    ).resolves.toBe("allowed");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/rest/v1/rpc/rate_limit_hit_many",
      expect.any(Object),
    );
  });

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

  it("consumes every validated bucket in one durable RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("true", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      consumeEdgeDurableRateLimits({
        scope: "booking-page",
        material: ["203.0.113.11"],
        buckets: [
          { name: "minute", limit: 180, windowSeconds: 60 },
          { name: "hour", limit: 1_200, windowSeconds: 3_600 },
        ],
      }),
    ).resolves.toBe("allowed");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      p_buckets: Array<Record<string, unknown>>;
    };
    expect(body.p_buckets).toHaveLength(2);
    expect(body.p_buckets).toEqual([
      expect.objectContaining({ p_limit: 180, p_window_seconds: 60 }),
      expect.objectContaining({ p_limit: 1_200, p_window_seconds: 3_600 }),
    ]);
    expect(JSON.stringify(body)).not.toContain("203.0.113.11");
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
