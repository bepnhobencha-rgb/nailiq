import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateSquareGiftCard,
  createSquareDigitalGiftCard,
  createSquareGiftCardPayment,
  findExactSquarePaymentByReference,
  getSquareConfig,
  type SquareConfig,
  type SquarePayment,
} from "../client";

const config: SquareConfig = {
  salonId: "11111111-1111-4111-8111-111111111111",
  merchantId: "merchant-1",
  locationId: "location-1",
  accessToken: "sandbox-token",
  applicationId: "sandbox-app-1",
  environment: "sandbox",
  currency: "CAD",
  sync: {
    pullCreate: false,
    pullUpdate: false,
    pullCancel: false,
    pushCreate: false,
    pushUpdate: false,
    pushCancel: false,
  },
};

function fetchMock(response: Record<string, unknown>) {
  const fetcher = vi.fn(async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ) => {
    void _input;
    void _init;
    return {
      ok: true,
      json: async () => response,
    };
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

const recoveryQuery = {
  referenceId: "gift-card-payment:request-1",
  amountCents: 5_000,
  currency: "CAD",
  beginTime: "2026-08-22T01:00:00Z",
  endTime: "2026-08-22T02:00:00Z",
};

function payment(overrides: Partial<SquarePayment> = {}): SquarePayment {
  return {
    id: "payment-1",
    status: "COMPLETED",
    created_at: "2026-08-22T01:30:00Z",
    location_id: config.locationId,
    amount_money: { amount: recoveryQuery.amountCents, currency: recoveryQuery.currency },
    application_details: { application_id: config.applicationId! },
    reference_id: recoveryQuery.referenceId,
    ...overrides,
  };
}

describe("Square Gift Card HTTP contracts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a DIGITAL card without accepting or sending a GAN", async () => {
    const fetcher = fetchMock({ gift_card: { id: "gftc:1" } });
    await createSquareDigitalGiftCard(
      config,
      { idempotencyKey: "nq:create" },
      "2026-07-15",
    );
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://connect.squareupsandbox.com/v2/gift-cards");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotency_key: "nq:create",
      location_id: "location-1",
      gift_card: { type: "DIGITAL" },
    });
  });

  it("requires exact amount, order, location and no partial authorization", async () => {
    const fetcher = fetchMock({ payment: { id: "payment-1" } });
    await createSquareGiftCardPayment(config, {
      idempotencyKey: "nq:payment",
      sourceId: "cnon:buyer-token",
      amountCents: 5_000,
      currency: "CAD",
      orderId: "order-1",
    }, "2026-07-15");
    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotency_key: "nq:payment",
      source_id: "cnon:buyer-token",
      amount_money: { amount: 5_000, currency: "CAD" },
      autocomplete: true,
      accept_partial_authorization: false,
      order_id: "order-1",
      location_id: "location-1",
    });
  });

  it("activates the card against the exact Square order line", async () => {
    const fetcher = fetchMock({ gift_card_activity: { id: "gcact:1" } });
    await activateSquareGiftCard(config, {
      idempotencyKey: "nq:activate",
      giftCardId: "gftc:1",
      orderId: "order-1",
      lineItemUid: "line-1",
    }, "2026-07-15");
    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotency_key: "nq:activate",
      gift_card_activity: {
        gift_card_id: "gftc:1",
        type: "ACTIVATE",
        location_id: "location-1",
        activate_activity_details: {
          order_id: "order-1",
          line_item_uid: "line-1",
        },
      },
    });
  });
});

describe("Square payment recovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the sandbox ListPayments URL and returns one exact receipt", async () => {
    const exact = payment();
    const fetcher = fetchMock({ payments: [exact] });

    await expect(findExactSquarePaymentByReference(config, recoveryQuery))
      .resolves.toEqual(exact);

    const [rawUrl, init] = fetcher.mock.calls[0];
    const url = new URL(String(rawUrl));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://connect.squareupsandbox.com/v2/payments",
    );
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      location_id: config.locationId,
      begin_time: recoveryQuery.beginTime,
      end_time: recoveryQuery.endTime,
      sort_order: "ASC",
      limit: "100",
    });
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer sandbox-token",
      "Square-Version": "2024-12-18",
    });
  });

  it("returns null when no payment has the exact reference", async () => {
    fetchMock({ payments: [payment({ reference_id: "another-reference" })] });

    await expect(findExactSquarePaymentByReference(config, recoveryQuery))
      .resolves.toBeNull();
  });

  it("fails closed when the exact reference has multiple payments", async () => {
    fetchMock({
      payments: [payment(), payment({ id: "payment-2" })],
    });

    await expect(findExactSquarePaymentByReference(config, recoveryQuery))
      .rejects.toThrow("square_payment_recovery_multiple_matches");
  });

  it("fails closed when the referenced receipt material is not exact", async () => {
    fetchMock({
      payments: [payment({ amount_money: { amount: 4_999, currency: "CAD" } })],
    });

    await expect(findExactSquarePaymentByReference(config, recoveryQuery))
      .rejects.toThrow("square_payment_recovery_receipt_invalid");
  });

  it("stops after five full pages instead of trusting an incomplete scan", async () => {
    let page = 0;
    const fetcher = vi.fn(async () => {
      page += 1;
      return {
        ok: true,
        json: async () => ({ payments: [], cursor: `cursor-${page}` }),
      };
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(findExactSquarePaymentByReference(config, recoveryQuery))
      .rejects.toThrow("square_payment_recovery_pagination_limit_exceeded");
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});

describe("Square configuration boundaries", () => {
  const integrationRow = {
    salon_id: config.salonId,
    merchant_id: config.merchantId,
    location_id: config.locationId,
    access_token: config.accessToken,
    application_id: config.applicationId,
    environment: config.environment,
    sync_pull_create: null,
    sync_pull_update: null,
    sync_pull_cancel: null,
    sync_push_create: null,
    sync_push_update: null,
    sync_push_cancel: null,
  };

  function configDb(salonResult: {
    data: { currency_code?: unknown } | null;
    error: Record<string, unknown> | null;
  }) {
    return {
      from: vi.fn((table: string) => {
        const result = table === "square_integrations"
          ? { data: integrationRow, error: null }
          : salonResult;
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => result,
        };
        return chain;
      }),
    };
  }

  it("rejects an unknown stored environment before it can default to production", async () => {
    const maybeSingle = vi.fn(async () => ({
      data: {
        salon_id: config.salonId,
        merchant_id: config.merchantId,
        location_id: config.locationId,
        access_token: config.accessToken,
        application_id: config.applicationId,
        environment: "staging",
        sync_pull_create: null,
        sync_pull_update: null,
        sync_pull_cancel: null,
        sync_push_create: null,
        sync_push_update: null,
        sync_push_cancel: null,
      },
      error: null,
    }));
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const db = { from: vi.fn(() => ({ select })) };

    await expect(getSquareConfig(db as never, config.salonId))
      .rejects.toThrow("square_integrations.environment is invalid");
    expect(db.from).toHaveBeenCalledTimes(1);
    expect(db.from).toHaveBeenCalledWith("square_integrations");
  });

  it("loads and normalizes an explicit salon currency", async () => {
    const db = configDb({ data: { currency_code: " cad " }, error: null });

    await expect(getSquareConfig(db as never, config.salonId)).resolves.toMatchObject({
      currency: "CAD",
    });
    expect(db.from).toHaveBeenCalledWith("salons");
  });

  it.each([
    ["read error", { data: null, error: { code: "57014", message: "private detail" } }, "square_salon_currency_unavailable"],
    ["missing row", { data: null, error: null }, "square_salon_currency_unavailable"],
    ["blank currency", { data: { currency_code: " " }, error: null }, "square_salon_currency_invalid"],
    ["malformed currency", { data: { currency_code: "CAD$" }, error: null }, "square_salon_currency_invalid"],
  ] as const)(
    "fails closed for %s instead of defaulting money requests to USD",
    async (_label, salonResult, expectedMessage) => {
      const db = configDb(salonResult);
      await expect(getSquareConfig(db as never, config.salonId)).rejects.toThrow(
        expectedMessage,
      );
    },
  );
});
