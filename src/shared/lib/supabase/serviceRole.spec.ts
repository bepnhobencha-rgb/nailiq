import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServiceRoleClient } from "./serviceRole";

beforeEach(() => {
  vi.stubEnv("SUPABASE_INTERNAL_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-test-key");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("opt-in service-role request deadline", () => {
  it("aborts a stalled transport and never replays a metering RPC", async () => {
    const transport = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(init?.signal?.reason);
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    }));
    vi.stubGlobal("fetch", transport);
    const result = await createServiceRoleClient({ timeoutMs: 20 }).rpc("rate_limit_hit", { p_key: "synthetic" });
    expect(result.error).not.toBeNull();
    expect(result.data).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("preserves an earlier caller cancellation", async () => {
    const transport = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });
    vi.stubGlobal("fetch", transport);
    const abort = new AbortController();
    abort.abort();
    const result = await createServiceRoleClient({ timeoutMs: 10_000 }).rpc("quote_group_booking", {}).abortSignal(abort.signal);
    expect(result.error).not.toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not let the SDK retry a timed-out GET with a fresh deadline", async () => {
    const transport = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", transport);
    const result = await createServiceRoleClient({ timeoutMs: 20 }).from("salons").select("id");
    expect(result.error).not.toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("keeps a successful response intact", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("true", { status: 200, headers: { "Content-Type": "application/json" } })));
    const result = await createServiceRoleClient({ timeoutMs: 1_000 }).rpc("rate_limit_hit", {});
    expect(result.error).toBeNull();
    expect(result.data).toBe(true);
  });
});
