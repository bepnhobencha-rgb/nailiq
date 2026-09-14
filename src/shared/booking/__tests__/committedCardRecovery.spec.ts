import { afterEach, describe, expect, it, vi } from "vitest";
import { committedCardRecoveryHref, parseCommittedCardRecovery, recoverCommittedCardCapability } from "@/shared/booking/committedCardRecovery";

const binding = { salonId: "11111111-1111-4111-8111-111111111111", bookingId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "33333333-3333-4333-8333-333333333333", pricingFingerprint: "a".repeat(64) };
const token = "44444444-4444-4444-8444-444444444444";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.useRealTimers());

describe("committed card capability recovery", () => {
  it("survives a URL roundtrip and excludes all input except exact create authority", () => {
    const href = committedCardRecoveryHref({ ...binding, sourceId: "DO_NOT_PERSIST", email: "PRIVATE", consent: true } as typeof binding);
    const url = new URL(href!, "https://example.test");
    expect(url.pathname).toBe("/booking/recover-card");
    expect(url.search).toBe("");
    expect(parseCommittedCardRecovery(url.hash)).toEqual(binding);
    expect(href).not.toContain("DO_NOT_PERSIST");
    expect(href).not.toContain("PRIVATE");
    expect(href).not.toContain("consent");
  });

  it.each(["", "#recover=booking-id", "#recover=javascript:alert(1)", "#recover=" + "a".repeat(2048)])("rejects malformed authority without network work (%s)", async hash => {
    expect(parseCommittedCardRecovery(hash)).toBeNull();
    const fetcher = vi.fn();
    expect(await recoverCommittedCardCapability({ ...binding, bookingId: hash }, fetcher)).toEqual({ status: "expired" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("recovers by capability only, with no provider/source or booking submission", async () => {
    const fetcher = vi.fn(async () => json({ ok: true, required: true, token }));
    expect(await recoverCommittedCardCapability(binding, fetcher)).toEqual({ status: "ready", token });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/booking/card-capability", expect.objectContaining({
      method: "POST", cache: "no-store", body: JSON.stringify({...binding, includeReceipt: true}),
    }));
  });

  it("sends the same authority on a manual retry after lost response, never a source", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(json({ ok: true, required: true, token }));
    expect(await recoverCommittedCardCapability(binding, fetcher)).toEqual({ status: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await recoverCommittedCardCapability(binding, fetcher)).toEqual({ status: "ready", token });
    expect(fetcher.mock.calls.map(([url, init]) => [url, init.body])).toEqual(Array(2).fill(["/api/booking/card-capability", JSON.stringify({...binding, includeReceipt: true})]));
  });

  it.each([
    [{ ok: false }, 503, "unavailable"],
    [{ ok: false, code: "rate_limited" }, 429, "unavailable"],
    [{ ok: false, code: "exchange_expired" }, 404, "expired"],
    [{ ok: false, code: "create_binding_invalid" }, 404, "expired"],
    [{ ok: true, required: false, token: null }, 200, "unavailable"],
    [{ ok: true, required: true, token: null }, 200, "unavailable"],
    [{ ok: true, required: true, token: "javascript:alert(1)" }, 200, "unavailable"],
    [{ ok: true, token }, 200, "unavailable"],
  ] as const)("validates status/receipt without assuming protection: %j", async (body, status, expected) => {
    expect(await recoverCommittedCardCapability(binding, vi.fn(async () => json(body, status)))).toEqual({ status: expected });
  });

  it.each(["request", "body"])("bounds a stalled %s to five seconds without automatic retry", async stage => {
    vi.useFakeTimers();
    const never = () => new Promise<Response>(() => undefined);
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      void _url; void _init;
      return stage === "request" ? never() : { ok: true, status: 200, json: never } as unknown as Response;
    });
    const result = recoverCommittedCardCapability(binding, fetcher);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toEqual({ status: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not mistake the release gate for a verified reservation", async () => {
    expect(await recoverCommittedCardCapability(binding, vi.fn(async () => json({ok:true,required:false,cardManagementStatus:"not_applicable"})))).toEqual({status:"not_applicable"});
  });
  const receipt = {salonName:"QA",startTimeUtc:"2026-09-15T19:00:00+00:00",timezone:"America/Vancouver",services:["Manicure","Pedicure"]};
  it("accepts a minimal verified reservation without claiming card protection", async () => {
    expect(await recoverCommittedCardCapability(binding, vi.fn(async () => json({ok:true,required:false,receipt:{...receipt,phone:"DO_NOT_RETURN"}})))).toEqual({status:"not_required",receipt});
  });
  it.each([{timezone:"invalid-zone"},{services:[]},{services:[null]},{startTimeUtc:"tomorrow"},{salonName:""}])("rejects malformed reservation details: %j", async (bad) => {
    expect(await recoverCommittedCardCapability(binding, vi.fn(async () => json({ok:true,required:false,receipt:{...receipt,...bad}})))).toEqual({status:"unavailable"});
  });

});
