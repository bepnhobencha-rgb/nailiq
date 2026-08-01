import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchNailTryOn,
  NailTryOnRequestTimeoutError,
} from "../timeouts";

describe("Nail Try-On request deadlines", () => {
  afterEach(() => vi.useRealTimers());

  it("passes an abort signal and clears the deadline after success", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await fetchNailTryOn("/try-on", { method: "POST" }, 1_000, fetchImpl);

    expect(response.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a request at its deadline and returns a stable timeout error", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
    ) as unknown as typeof fetch;

    const request = fetchNailTryOn("/try-on", { method: "POST" }, 1_000, fetchImpl);
    const rejection = expect(request).rejects.toBeInstanceOf(
      NailTryOnRequestTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves non-timeout network failures", async () => {
    const networkError = new Error("offline");
    const fetchImpl = vi.fn().mockRejectedValue(networkError);
    await expect(
      fetchNailTryOn("/try-on", { method: "POST" }, 1_000, fetchImpl),
    ).rejects.toBe(networkError);
  });
});
