import { describe, expect, it, vi } from "vitest";

import { settleCommittedBookingCardManagement } from "@/shared/booking/settleCommittedBookingCardManagement";

const baseInput = {
  customerPaymentGatewayEnabled: true,
  salonId: "11111111-1111-4111-8111-111111111111",
  bookingId: "22222222-2222-4222-8222-222222222222",
  createIdempotencyKey: "33333333-3333-4333-8333-333333333333",
  pricingFingerprint: "a".repeat(64),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("committed booking card-only continuation", () => {
  it("treats card management as not applicable while the V1 gateway is hard off", async () => {
    const fetcher = vi.fn();

    const result = await settleCommittedBookingCardManagement(
      { ...baseInput, customerPaymentGatewayEnabled: false },
      fetcher,
    );

    expect(result).toEqual({
      cardManagementToken: null,
      cardManagementPending: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the committed booking successful when capability exchange is unavailable", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ok: false }, 503));

    const result = await settleCommittedBookingCardManagement(baseInput, fetcher);

    expect(result).toEqual({
      cardManagementToken: null,
      cardManagementPending: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/booking/card-capability",
      expect.objectContaining({
        body: JSON.stringify({
          salonId: baseInput.salonId,
          bookingId: baseInput.bookingId,
          idempotencyKey: baseInput.createIdempotencyKey,
          pricingFingerprint: baseInput.pricingFingerprint,
        }),
      }),
    );
  });

  it("bounds an unresponsive post-commit capability request", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(
        async (...args: [RequestInfo | URL, RequestInit?]) => {
          void args;
          return await new Promise<Response>(() => undefined);
        },
      );

      const resultPromise = settleCommittedBookingCardManagement(baseInput, fetcher);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(resultPromise).resolves.toEqual({
        cardManagementToken: null,
        cardManagementPending: true,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const init = fetcher.mock.calls[0]?.[1] as RequestInit;
      expect(init.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("also bounds a capability response whose body never finishes", async () => {
    vi.useFakeTimers();
    try {
      const stalledResponse = {
        ok: true,
        json: async () => await new Promise<unknown>(() => undefined),
      } as Response;
      const fetcher = vi.fn(
        async (...args: [RequestInfo | URL, RequestInit?]) => {
          void args;
          return stalledResponse;
        },
      );

      const resultPromise = settleCommittedBookingCardManagement(baseInput, fetcher);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(resultPromise).resolves.toEqual({
        cardManagementToken: null,
        cardManagementPending: true,
      });
      const init = fetcher.mock.calls[0]?.[1] as RequestInit;
      expect(init.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the canonical create identity for one durable card save", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return String(url).endsWith("card-capability")
        ? jsonResponse({ ok: true, token: "44444444-4444-4444-8444-444444444444" })
        : jsonResponse({ ok: true, code: "saved" });
    });

    const result = await settleCommittedBookingCardManagement(
      {
        ...baseInput,
        cardSourceId: "provider-token",
        cardVerificationToken: "verification-token",
        consent: true,
      },
      fetcher,
    );

    expect(result).toEqual({
      cardManagementToken: null,
      cardManagementPending: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const saveInit = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(saveInit.body))).toEqual({
      token: "44444444-4444-4444-8444-444444444444",
      requestId: baseInput.createIdempotencyKey,
      provider: "square",
      sourceId: "provider-token",
      verificationToken: "verification-token",
      consent: true,
    });
  });

  it("does not redispatch or expose a possibly consumed token after an ambiguous save", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return String(url).endsWith("card-capability")
        ? jsonResponse({ ok: true, token: "44444444-4444-4444-8444-444444444444" })
        : jsonResponse({ ok: false, code: "save_unknown" }, 503);
    });

    const result = await settleCommittedBookingCardManagement(
      {
        ...baseInput,
        cardSourceId: "provider-token",
        consent: true,
      },
      fetcher,
    );

    expect(result).toEqual({
      cardManagementToken: null,
      cardManagementPending: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("square-save-card"))).toHaveLength(1);
  });

  it("returns only a card continuation token when no provider mutation ran", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ ok: true, token: "44444444-4444-4444-8444-444444444444" }),
    );

    const result = await settleCommittedBookingCardManagement(baseInput, fetcher);

    expect(result).toEqual({
      cardManagementToken: "44444444-4444-4444-8444-444444444444",
      cardManagementPending: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed saved-card reuse separate from the booking result", async () => {
    const reuseSavedCard = vi.fn(async () => ({ ok: false, reason: "lookup_unavailable" }));
    const fetcher = vi.fn(async () =>
      jsonResponse({ ok: true, token: "44444444-4444-4444-8444-444444444444" }),
    );

    const result = await settleCommittedBookingCardManagement(
      { ...baseInput, reuseSavedCard },
      fetcher,
    );

    expect(result).toEqual({
      cardManagementToken: null,
      cardManagementPending: true,
    });
    expect(reuseSavedCard).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
