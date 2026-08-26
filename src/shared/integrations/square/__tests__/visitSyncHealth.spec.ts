import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getSquareConfig: vi.fn(),
  loadSquareCustomerIdentityMap: vi.fn(),
  upsert: vi.fn(),
  watermark: {
    data: null as Record<string, unknown> | null,
    error: null as Record<string, unknown> | null,
  },
  existingVisits: {
    data: [] as Record<string, unknown>[] | null,
    error: null as Record<string, unknown> | null,
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("../looseDb", () => ({
  looseServiceClient: () => ({ from: mocks.from }),
}));
vi.mock("../client", () => ({
  getSquareConfig: mocks.getSquareConfig,
}));
vi.mock("../customerIdentity", () => ({
  loadSquareCustomerIdentityMap: mocks.loadSquareCustomerIdentityMap,
}));

import { syncSquareVisitHistory } from "../visitSync";

const SALON_ID = "63000000-0000-4000-8000-000000000001";

function payment(index = 0) {
  return {
    id: `square-payment-${index}`,
    status: "COMPLETED",
    customer_id: `square-customer-${index}`,
    created_at: "2026-08-23T12:00:00.000Z",
    amount_money: { amount: 4_000 },
  };
}

function squareResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Square visit sync health truth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.watermark.data = null;
    mocks.watermark.error = null;
    mocks.existingVisits.data = [];
    mocks.existingVisits.error = null;
    mocks.getSquareConfig.mockResolvedValue({
      salonId: SALON_ID,
      merchantId: "merchant-local",
      locationId: "location-local",
      accessToken: "fake-local-token",
      applicationId: "fake-local-app",
      environment: "sandbox",
      currency: "CAD",
      sync: {
        pullCreate: true,
        pullUpdate: true,
        pullCancel: true,
        pushCreate: false,
        pushUpdate: false,
        pushCancel: false,
      },
    });
    mocks.loadSquareCustomerIdentityMap.mockResolvedValue(new Map());
    mocks.upsert.mockResolvedValue({ data: null, error: null });
    mocks.from.mockImplementation(() => {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: () => Promise.resolve(structuredClone(mocks.watermark)),
        in: () => Promise.resolve(structuredClone(mocks.existingVisits)),
        upsert: mocks.upsert,
      };
      return query;
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(squareResponse({ payments: [] })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a stable failure when config loading fails", async () => {
    mocks.getSquareConfig.mockRejectedValue(new Error("private credential detail"));

    const result = await syncSquareVisitHistory(SALON_ID);

    expect(result).toEqual({
      ok: false,
      paymentsScanned: 0,
      upserted: 0,
      withServices: 0,
      error: "square_visit_config_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("private credential detail");
  });

  it("fails closed on a watermark read error before provider access", async () => {
    mocks.watermark.error = { code: "42501", message: "private database detail" };

    const result = await syncSquareVisitHistory(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      error: "square_visit_watermark_unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private database detail");
  });

  it("fails closed on an invalid watermark", async () => {
    mocks.watermark.data = { square_created_at: "not-a-date" };

    await expect(syncSquareVisitHistory(SALON_ID)).resolves.toMatchObject({
      ok: false,
      error: "square_visit_watermark_invalid",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a stable provider failure for transport and HTTP errors", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("private transport detail"));
    const transport = await syncSquareVisitHistory(SALON_ID);
    expect(transport).toMatchObject({
      ok: false,
      error: "square_visit_provider_read_unavailable",
    });
    expect(JSON.stringify(transport)).not.toContain("private transport detail");

    vi.mocked(fetch).mockResolvedValueOnce(squareResponse({ secret: "private" }, 503));
    const http = await syncSquareVisitHistory(SALON_ID);
    expect(http).toMatchObject({
      ok: false,
      error: "square_visit_provider_read_unavailable",
    });
    expect(JSON.stringify(http)).not.toContain("private");
  });

  it("returns a stable failure for malformed or provider-error responses", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    await expect(syncSquareVisitHistory(SALON_ID)).resolves.toMatchObject({
      ok: false,
      error: "square_visit_provider_response_invalid",
    });

    vi.mocked(fetch).mockResolvedValueOnce(squareResponse({
      errors: [{ detail: "private provider detail" }],
    }));
    const providerError = await syncSquareVisitHistory(SALON_ID);
    expect(providerError).toMatchObject({
      ok: false,
      error: "square_visit_provider_response_invalid",
    });
    expect(JSON.stringify(providerError)).not.toContain("private provider detail");
  });

  it("does not report partial success when pagination exceeds the hard cap", async () => {
    vi.mocked(fetch).mockImplementation(async () => squareResponse({
      payments: [],
      cursor: "more-pages-remain",
    }));

    const result = await syncSquareVisitHistory(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      paymentsScanned: 0,
      upserted: 0,
      error: "square_visit_pagination_limit_exceeded",
    });
    expect(fetch).toHaveBeenCalledTimes(50);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("returns a stable failure when the tenant-scoped identity map is unavailable", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(squareResponse({ payments: [payment()] }));
    mocks.loadSquareCustomerIdentityMap.mockRejectedValue(
      new Error("private identity detail"),
    );

    const result = await syncSquareVisitHistory(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      paymentsScanned: 1,
      upserted: 0,
      error: "square_visit_identity_map_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("private identity detail");
  });

  it("preserves an exact existing salon/payment/customer profile when the scoped map is empty", async () => {
    const profileId = "73000000-0000-4000-8000-000000000001";
    vi.mocked(fetch).mockResolvedValueOnce(squareResponse({ payments: [payment()] }));
    mocks.existingVisits.data = [{
      square_payment_id: "square-payment-0",
      square_customer_id: "square-customer-0",
      client_profile_id: profileId,
    }];

    const result = await syncSquareVisitHistory(SALON_ID);

    expect(result).toMatchObject({ ok: true, upserted: 1 });
    expect(mocks.upsert).toHaveBeenCalledWith(
      [expect.objectContaining({
        square_payment_id: "square-payment-0",
        client_profile_id: profileId,
      })],
      { onConflict: "salon_id,square_payment_id" },
    );
  });

  it("fails closed when the existing scoped visit identity lookup fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(squareResponse({ payments: [payment()] }));
    mocks.existingVisits.error = { code: "42501", message: "private database detail" };

    const result = await syncSquareVisitHistory(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      paymentsScanned: 1,
      upserted: 0,
      error: "square_visit_existing_identity_lookup_unavailable",
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private database detail");
  });

  it("rejects a stored payment/customer conflict instead of preserving across identities", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(squareResponse({ payments: [payment()] }));
    mocks.existingVisits.data = [{
      square_payment_id: "square-payment-0",
      square_customer_id: "different-square-customer",
      client_profile_id: "73000000-0000-4000-8000-000000000001",
    }];

    const result = await syncSquareVisitHistory(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      error: "square_visit_existing_identity_conflict",
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["transport", new Error("private order transport detail")],
    ["HTTP", squareResponse({ secret: "private order HTTP detail" }, 503)],
  ])("fails closed on an order-service %s read failure", async (_kind, failure) => {
    const paymentWithOrder = { ...payment(), order_id: "square-order-0" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(squareResponse({ payments: [paymentWithOrder] }));
    if (failure instanceof Error) {
      vi.mocked(fetch).mockRejectedValueOnce(failure);
    } else {
      vi.mocked(fetch).mockResolvedValueOnce(failure);
    }

    const result = await syncSquareVisitHistory(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      paymentsScanned: 1,
      upserted: 0,
      error: "square_visit_order_provider_read_unavailable",
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private order");
  });

  it.each([
    ["malformed JSON", new Response("not-json", { status: 200 })],
    ["provider errors", squareResponse({
      errors: [{ detail: "private order provider detail" }],
    })],
    ["malformed schema", squareResponse({ orders: "not-an-array" })],
  ])("fails closed on an order-service %s response", async (_kind, response) => {
    const paymentWithOrder = { ...payment(), order_id: "square-order-0" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(squareResponse({ payments: [paymentWithOrder] }))
      .mockResolvedValueOnce(response);

    const result = await syncSquareVisitHistory(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      paymentsScanned: 1,
      upserted: 0,
      error: "square_visit_order_provider_response_invalid",
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private order");
  });

  it("keeps absent service names optional in an otherwise valid exact order response", async () => {
    const paymentWithOrder = { ...payment(), order_id: "square-order-0" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(squareResponse({ payments: [paymentWithOrder] }))
      .mockResolvedValueOnce(squareResponse({
        orders: [{ id: "square-order-0", line_items: [{}] }],
      }));

    const result = await syncSquareVisitHistory(SALON_ID);

    expect(result).toEqual({
      ok: true,
      paymentsScanned: 1,
      upserted: 1,
      withServices: 0,
    });
    expect(mocks.upsert).toHaveBeenCalledWith(
      [expect.objectContaining({ service_names: null })],
      { onConflict: "salon_id,square_payment_id" },
    );
  });

  it("does not write a partial visit batch when a later order-service batch fails", async () => {
    const payments = Array.from({ length: 101 }, (_, index) => ({
      ...payment(index),
      order_id: `square-order-${index}`,
    }));
    vi.mocked(fetch)
      .mockResolvedValueOnce(squareResponse({ payments }))
      .mockResolvedValueOnce(squareResponse({ orders: [] }))
      .mockResolvedValueOnce(squareResponse({ secret: "private later batch detail" }, 503));

    const result = await syncSquareVisitHistory(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      paymentsScanned: 101,
      upserted: 0,
      error: "square_visit_order_provider_read_unavailable",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private later batch detail");
  });

  it("never reports ok=true when any upsert chunk fails", async () => {
    const payments = Array.from({ length: 501 }, (_, index) => payment(index));
    vi.mocked(fetch).mockResolvedValueOnce(squareResponse({ payments }));
    mocks.upsert
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { code: "42501", message: "private database detail" },
      });

    const result = await syncSquareVisitHistory(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      paymentsScanned: 501,
      upserted: 500,
      withServices: 0,
      error: "square_visit_upsert_unavailable",
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("private database detail");
  });

  it("returns ok=true only after every write succeeds", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(squareResponse({ payments: [payment()] }));

    const result = await syncSquareVisitHistory(SALON_ID);

    expect(result).toEqual({
      ok: true,
      paymentsScanned: 1,
      upserted: 1,
      withServices: 0,
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });
});
