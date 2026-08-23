import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  createPaymentLink: vi.fn(),
  getSquareConfig: vi.fn(),
  runPaymentOperation: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock("./client", () => ({
  createPaymentLink: mocks.createPaymentLink,
  getSquareConfig: mocks.getSquareConfig,
  getOrder: vi.fn(),
}));
vi.mock("@/shared/payments/executeBookingPaymentOperation", () => ({
  runAuthoritativeBookingPaymentOperation: mocks.runPaymentOperation,
}));

import { createDepositForBooking, refundDeposit } from "./deposits";

const SALON_ID = "123e4567-e89b-42d3-a456-426614174000";
const BOOKING_ID = "223e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "323e4567-e89b-42d3-a456-426614174000";
const OPERATION_ID = "423e4567-e89b-42d3-a456-426614174000";
const ATTEMPT_ID = "523e4567-e89b-42d3-a456-426614174000";
const FP = "a".repeat(64);
const ACCOUNT_FP = createHash("sha256")
  .update("square:merchant_qa:location_qa:sandbox", "utf8")
  .digest("hex");

function bookingQuery() {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({
    data: { id: BOOKING_ID, salon_id: SALON_ID, client_name: "QA Guest" },
    error: null,
  }));
  return chain;
}

function queryResult(data: Record<string, unknown> | null, error: unknown = null) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data, error }));
  return chain;
}

function claim(code = "link_claimed") {
  return {
    success: true,
    code,
    status: "sending",
    operation_id: OPERATION_ID,
    booking_id: BOOKING_ID,
    attempt_token: ATTEMPT_ID,
    provider_idempotency_key: `nq:${OPERATION_ID}`,
    lease_expires_at: "2026-08-20T22:00:00.000Z",
    material_fingerprint: FP,
    material: {
      salon_id: SALON_ID,
      booking_id: BOOKING_ID,
      operation_kind: "deposit_charge",
      delivery_mode: "square_hosted_link",
      provider: "square",
      provider_account_fingerprint: ACCOUNT_FP,
      amount_cents: 2_500,
      currency: "CAD",
      hold: false,
    },
    provider_material: {
      provider_account_id: "merchant_qa",
      provider_location_id: "location_qa",
      provider_environment: "sandbox",
      currency: "CAD",
      amount_cents: 2_500,
      booking_reference: BOOKING_ID,
      delivery_mode: "square_hosted_link",
    },
  };
}

describe("authoritative Square hosted deposit link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockReturnValue(bookingQuery());
    mocks.getSquareConfig.mockResolvedValue({
      merchantId: "merchant_qa",
      locationId: "location_qa",
      currency: "CAD",
      environment: "sandbox",
    });
    mocks.createPaymentLink.mockResolvedValue({
      id: "link_qa",
      orderId: "order_qa",
      url: "https://square.test/pay/link_qa",
    });
    mocks.runPaymentOperation.mockResolvedValue({
      ok: true,
      status: "succeeded",
      operationId: OPERATION_ID,
      providerReceipt: "refund_qa",
    });
  });

  it("claims before provider, reuses the ledger key after attach response loss, and attaches one receipt", async () => {
    let claimCount = 0;
    let attachCount = 0;
    let attached = false;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_booking_square_deposit_link") {
        claimCount += 1;
        return attached
          ? {
              data: {
                success: true,
                code: "link_ready",
                status: "pending_provider",
                operation_id: OPERATION_ID,
                booking_id: BOOKING_ID,
                provider_link_id: "link_qa",
                provider_order_id: "order_qa",
                link_url: "https://square.test/pay/link_qa",
                material_fingerprint: FP,
                material: { amount_cents: 2_500 },
              },
              error: null,
            }
          : { data: claim("link_claimed"), error: null };
      }
      if (name === "attach_booking_square_deposit_link") {
        attachCount += 1;
        attached = true;
        throw new Error("response_lost");
      }
      throw new Error(`unexpected ${name}`);
    });

    await expect(createDepositForBooking(BOOKING_ID, {
      hold: false,
      requestId: REQUEST_ID,
    })).rejects.toThrow("response_lost");
    const result = await createDepositForBooking(BOOKING_ID, {
      hold: false,
      requestId: REQUEST_ID,
    });

    expect(result).toMatchObject({
      required: true,
      amountCents: 2_500,
      url: "https://square.test/pay/link_qa",
    });
    expect(mocks.createPaymentLink).toHaveBeenCalledTimes(1);
    expect(mocks.createPaymentLink.mock.calls.map((call) => call[1].idempotencyKey))
      .toEqual([`nq:${OPERATION_ID}`]);
    expect(attachCount).toBe(1);
    expect(claimCount).toBe(2);
    expect(mocks.rpc.mock.calls.map((call) => call[0]))
      .toEqual([
        "claim_booking_square_deposit_link",
        "attach_booking_square_deposit_link",
        "claim_booking_square_deposit_link",
      ]);
  });
});

describe("authoritative Square deposit refund wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runPaymentOperation.mockResolvedValue({
      ok: true,
      status: "succeeded",
      operationId: OPERATION_ID,
      providerReceipt: "refund_qa",
    });
  });

  it("returns the DB cumulative receipt after a partial refund and tenant-scopes the reread", async () => {
    const context = queryResult({
      id: BOOKING_ID,
      salon_id: SALON_ID,
      deposit_amount_cents: 1_000,
      deposit_refunded_cents: 0,
    });
    const receipt = queryResult({ deposit_refunded_cents: 400 });
    mocks.from.mockReturnValueOnce(context).mockReturnValueOnce(receipt);

    const result = await refundDeposit(BOOKING_ID, {
      requestId: REQUEST_ID,
      amountCents: 400,
    });

    expect(mocks.runPaymentOperation).toHaveBeenCalledWith(expect.objectContaining({
      salonId: SALON_ID,
      bookingId: BOOKING_ID,
      requestId: REQUEST_ID,
      operationKind: "deposit_refund",
      amountCents: 400,
    }));
    expect(receipt.eq).toHaveBeenNthCalledWith(1, "salon_id", SALON_ID);
    expect(receipt.eq).toHaveBeenNthCalledWith(2, "id", BOOKING_ID);
    expect(result).toEqual({
      ok: true,
      reason: "refunded",
      refundedCents: 400,
      remainingCents: 600,
    });
  });

  it("defaults the second refund to the exact remaining amount", async () => {
    mocks.from
      .mockReturnValueOnce(queryResult({
        id: BOOKING_ID,
        salon_id: SALON_ID,
        deposit_amount_cents: 1_000,
        deposit_refunded_cents: 400,
      }))
      .mockReturnValueOnce(queryResult({ deposit_refunded_cents: 1_000 }));

    const result = await refundDeposit(BOOKING_ID, { requestId: REQUEST_ID });

    expect(mocks.runPaymentOperation).toHaveBeenCalledWith(expect.objectContaining({
      amountCents: 600,
    }));
    expect(result).toEqual({
      ok: true,
      reason: "refunded",
      refundedCents: 1_000,
      remainingCents: 0,
    });
  });

  it("rejects an over-refund before claiming or dispatching an operation", async () => {
    mocks.from.mockReturnValueOnce(queryResult({
      id: BOOKING_ID,
      salon_id: SALON_ID,
      deposit_amount_cents: 1_000,
      deposit_refunded_cents: 400,
    }));

    const result = await refundDeposit(BOOKING_ID, {
      requestId: REQUEST_ID,
      amountCents: 601,
    });

    expect(mocks.runPaymentOperation).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "invalid refund amount" });
  });
});
