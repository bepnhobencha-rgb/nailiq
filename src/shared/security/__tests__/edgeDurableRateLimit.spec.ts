import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consumeEdgeDurableRateLimits } from "../edgeDurableRateLimit";

const requestBatchMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260823093507_batch_edge_rate_limit_requests.sql",
  ),
  "utf8",
);
const limiterSource = readFileSync(
  resolve(process.cwd(), "src/shared/security/edgeDurableRateLimit.ts"),
  "utf8",
);

type BatchBody = {
  p_requests: Array<
    Array<{
      p_key: string;
      p_limit: number;
      p_window_seconds: number;
    }>
  >;
};

async function waitForCondition(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (condition()) return;
  throw new Error("condition was not met");
}

function parseBatchBody(init: RequestInit | undefined): BatchBody {
  return JSON.parse(String(init?.body)) as BatchBody;
}

function responseForBatch(
  init: RequestInit | undefined,
  values?: readonly boolean[],
) {
  const body = parseBatchBody(init);
  return new Response(
    JSON.stringify(values ?? body.p_requests.map(() => true)),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function oneBucket(material: string, scope = "booking-page") {
  return consumeEdgeDurableRateLimits({
    scope,
    material: [material],
    buckets: [{ name: "minute", limit: 180, windowSeconds: 60 }],
  });
}

function twoBuckets(material: string, scope = "booking-page") {
  return consumeEdgeDurableRateLimits({
    scope,
    material: [material],
    buckets: [
      { name: "minute", limit: 180, windowSeconds: 60 },
      { name: "hour", limit: 1_200, windowSeconds: 3_600 },
    ],
  });
}

describe("Proxy durable rate limiter", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_INTERNAL_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret";

    vi.stubGlobal("crypto", {
      subtle: {
        digest: vi.fn(async (_algorithm: string, data: BufferSource) => {
          const bytes = ArrayBuffer.isView(data)
            ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
            : Buffer.from(data);
          const digest = createHash("sha256").update(bytes).digest();
          return digest.buffer.slice(
            digest.byteOffset,
            digest.byteOffset + digest.byteLength,
          );
        }),
      },
    });
  });

  afterEach(() => {
    delete process.env.SUPABASE_INTERNAL_URL;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses the server-only origin and request-batch RPC", async () => {
    process.env.SUPABASE_INTERNAL_URL = "http://127.0.0.1:54321/";
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit) => responseForBatch(init),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(oneBucket("203.0.113.10")).resolves.toBe("allowed");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/rest/v1/rpc/rate_limit_hit_request_batch",
      expect.any(Object),
    );
  });

  it("sends only hashed material in the nested request payload", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit) => responseForBatch(init),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(twoBuckets("203.0.113.9")).resolves.toBe("allowed");

    const body = parseBatchBody(fetchMock.mock.calls[0]?.[1]);
    expect(body.p_requests).toHaveLength(1);
    expect(body.p_requests[0]).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("203.0.113.9");
    expect(body.p_requests[0]?.[0]?.p_key).toMatch(
      /^public-edge:booking-page:minute:[0-9a-f]{64}$/,
    );
    expect(body.p_requests[0]?.[1]).toEqual(
      expect.objectContaining({
        p_limit: 1_200,
        p_window_seconds: 3_600,
      }),
    );
  });

  it("coalesces disjoint calls and maps mixed positional results exactly", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit) =>
        responseForBatch(init, [true, false]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await Promise.all([
      twoBuckets("203.0.113.20"),
      twoBuckets("203.0.113.21"),
    ]);

    expect(results).toEqual(["allowed", "limited"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = parseBatchBody(fetchMock.mock.calls[0]?.[1]);
    expect(body.p_requests).toHaveLength(2);
    const keys = body.p_requests.flat().map((bucket) => bucket.p_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never co-batches overlapping keys and preserves their FIFO order", async () => {
    const releases: Array<(values: readonly boolean[]) => void> = [];
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          releases.push((values) =>
            resolve(responseForBatch(init, values)),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = twoBuckets("198.51.100.42");
    const second = twoBuckets("198.51.100.42");

    await waitForCondition(() => fetchMock.mock.calls.length === 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(parseBatchBody(fetchMock.mock.calls[0]?.[1]).p_requests).toHaveLength(1);

    releases[0]([true]);
    await expect(first).resolves.toBe("allowed");
    await waitForCondition(() => fetchMock.mock.calls.length === 2);
    expect(parseBatchBody(fetchMock.mock.calls[1]?.[1]).p_requests).toHaveLength(1);
    releases[1]([false]);

    await expect(second).resolves.toBe("limited");
    const firstKeys = parseBatchBody(fetchMock.mock.calls[0]?.[1]).p_requests[0]
      .map((bucket) => bucket.p_key);
    const secondKeys = parseBatchBody(fetchMock.mock.calls[1]?.[1]).p_requests[0]
      .map((bucket) => bucket.p_key);
    expect(secondKeys).toEqual(firstKeys);
  });

  it("partitions a disjoint queue at the 32-request RPC cap", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit) => responseForBatch(init),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        oneBucket(`203.0.113.${index}`),
      ),
    );

    expect(results.every((result) => result === "allowed")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls
        .map((call) => parseBatchBody(call[1]).p_requests.length)
        .sort((left, right) => right - left),
    ).toEqual([32, 32, 1]);
  });

  it("keeps different credentials in different physical RPCs", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit) => responseForBatch(init),
    );
    vi.stubGlobal("fetch", fetchMock);

    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret-a";
    const first = oneBucket("203.0.113.70");
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret-b";
    const second = oneBucket("203.0.113.71");

    await expect(Promise.all([first, second])).resolves.toEqual([
      "allowed",
      "allowed",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const authorizations = fetchMock.mock.calls.map(
      (call) => (call[1].headers as Record<string, string>).Authorization,
    );
    expect(authorizations).toEqual(
      expect.arrayContaining([
        "Bearer service-secret-a",
        "Bearer service-secret-b",
      ]),
    );
  });

  it("bounds physical batch RPC concurrency at six", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          releases.push(() => {
            active -= 1;
            resolve(responseForBatch(init));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const requests = Array.from({ length: 224 }, (_, index) =>
      oneBucket(`2001:db8::${index}`),
    );

    await waitForCondition(() => fetchMock.mock.calls.length === 6);
    expect(maximumActive).toBe(6);
    releases[0]();
    await waitForCondition(() => fetchMock.mock.calls.length === 7);
    for (const release of releases.slice(1)) release();

    const results = await Promise.all(requests);
    expect(results.every((result) => result === "allowed")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(maximumActive).toBe(6);
    expect(limiterSource).toMatch(/MAX_DURABLE_RPC_IN_FLIGHT = 6/);
  });

  it("rejects the 513th queued logical call and then recovers", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit) => responseForBatch(init),
    );
    vi.stubGlobal("fetch", fetchMock);

    const requests = Array.from({ length: 513 }, (_, index) =>
      oneBucket(`198.18.${Math.floor(index / 256)}.${index % 256}`),
    );
    const results = await Promise.all(requests);

    expect(results[512]).toBe("unavailable");
    expect(results.filter((result) => result === "unavailable")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(16);

    await expect(oneBucket("198.19.0.1")).resolves.toBe("allowed");
  });

  it("fails an over-waiting queued call closed and recovers queue capacity", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(responseForBatch(init)));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const requests = Array.from({ length: 7 }, (_, index) => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = `service-secret-${index}`;
      return oneBucket(`198.51.100.${index}`);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(2);
    await waitForCondition(() => fetchMock.mock.calls.length === 6);

    await vi.advanceTimersByTimeAsync(4_998);
    await expect(requests[6]).resolves.toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(6);

    for (const release of releases) release();
    await expect(Promise.all(requests.slice(0, 6))).resolves.toEqual(
      Array.from({ length: 6 }, () => "allowed"),
    );

    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret-recovered";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => responseForBatch(init)),
    );
    const recovered = oneBucket("198.51.100.99");
    await vi.advanceTimersByTimeAsync(2);
    await expect(recovered).resolves.toBe("allowed");
  });

  it("fails a timed-out physical RPC closed and releases the scheduler", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = vi.fn(
      () => new Promise<Response>(() => undefined),
    );
    vi.stubGlobal("fetch", fetchMock);

    const timedOut = oneBucket("203.0.113.200");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(2);
    await waitForCondition(() => fetchMock.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(timedOut).resolves.toBe("unavailable");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => responseForBatch(init)),
    );
    const recovered = oneBucket("203.0.113.201");
    await vi.advanceTimersByTimeAsync(2);
    await expect(recovered).resolves.toBe("allowed");
  });

  it("applies the physical timeout through response JSON parsing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise<unknown>(() => undefined),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const timedOut = oneBucket("203.0.113.205");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(2);
    await waitForCondition(() => fetchMock.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(timedOut).resolves.toBe("unavailable");
  });

  it("does not retry an ambiguous transport failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockImplementation(
        async (_url: string, init: RequestInit) => responseForBatch(init),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(oneBucket("203.0.113.210")).resolves.toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(oneBucket("203.0.113.211")).resolves.toBe("allowed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["null", () => new Response("null", { status: 200 })],
    ["non-array", () => new Response("true", { status: 200 })],
    ["wrong length", () => new Response("[]", { status: 200 })],
    ["non-boolean member", () => new Response('["true"]', { status: 200 })],
    ["non-2xx", () => new Response("down", { status: 503 })],
  ])("fails closed for a %s batch response and recovers", async (_label, makeResponse) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse())
      .mockImplementation(
        async (_url: string, init: RequestInit) => responseForBatch(init),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(oneBucket("198.51.100.80")).resolves.toBe("unavailable");
    await expect(oneBucket("198.51.100.81")).resolves.toBe("allowed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate keys before PostgREST", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      consumeEdgeDurableRateLimits({
        scope: "booking-page",
        material: ["203.0.113.250"],
        buckets: [
          { name: "minute", limit: 10, windowSeconds: 60 },
          { name: "minute", limit: 10, windowSeconds: 60 },
        ],
      }),
    ).resolves.toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["limit", 2_147_483_648, 60],
    ["window", 10, 2_147_483_648],
  ])(
    "rejects an out-of-int4 %s before it can collateral-fail a batch",
    async (_label, limit, windowSeconds) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        consumeEdgeDurableRateLimits({
          scope: "booking-page",
          material: ["203.0.113.251"],
          buckets: [{ name: "minute", limit, windowSeconds }],
        }),
      ).resolves.toBe("unavailable");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["scope", "", "minute", "203.0.113.251"],
    ["bucket name", "booking-page", "", "203.0.113.251"],
    ["material", "booking-page", "minute", ""],
  ])(
    "rejects empty %s material before PostgREST",
    async (_label, scope, name, material) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        consumeEdgeDurableRateLimits({
          scope,
          material: [material],
          buckets: [{ name, limit: 10, windowSeconds: 60 }],
        }),
      ).resolves.toBe("unavailable");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an oversized final hashed key before PostgREST", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      consumeEdgeDurableRateLimits({
        scope: `booking-${"x".repeat(240)}`,
        material: ["203.0.113.252"],
        buckets: [{ name: "minute", limit: 10, windowSeconds: 60 }],
      }),
    ).resolves.toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("matches the service-role-only SQL request-batch contract", () => {
    expect(requestBatchMigration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.rate_limit_hit_request_batch\([\s\S]*?RETURNS jsonb/,
    );
    expect(requestBatchMigration).toMatch(/v_request_count > 32/);
    expect(requestBatchMigration).toMatch(/v_bucket_count > 128/);
    expect(requestBatchMigration).toMatch(
      /v_distinct_key_count IS DISTINCT FROM v_bucket_count/,
    );
    expect(requestBatchMigration).toMatch(
      /jsonb_agg\([\s\S]*?ORDER BY per_request\.request_ordinal/,
    );
    expect(requestBatchMigration).toMatch(
      /REVOKE ALL ON FUNCTION public\.rate_limit_hit_request_batch\(jsonb\) FROM PUBLIC;[\s\S]*?FROM anon;[\s\S]*?FROM authenticated;[\s\S]*?GRANT EXECUTE[\s\S]*?TO service_role;/,
    );
  });
});
