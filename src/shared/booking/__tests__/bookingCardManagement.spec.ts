import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  resolveProvider: vi.fn(),
  removeSavedCard: vi.fn(),
  saveCardOnFile: vi.fn(),
  setupCreate: vi.fn(),
  setupRetrieve: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/shared/integrations/payments", () => ({
  resolvePaymentProvider: mocks.resolveProvider,
}));
vi.mock("@/shared/lib/stripe", () => ({
  getStripeClient: () => ({
    setupIntents: { create: mocks.setupCreate, retrieve: mocks.setupRetrieve },
  }),
}));

import {
  createStripeSetupWithManagementCapability,
  removeCardWithManagementCapability,
  saveCardWithManagementCapability,
} from "@/shared/booking/bookingCardManagement";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const FINAL_TOKEN = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const OPERATION = "44444444-4444-4444-8444-444444444444";
const ATTEMPT = "55555555-5555-4555-8555-555555555555";
const BOOKING = "66666666-6666-4666-8666-666666666666";
const SALON = "77777777-7777-4777-8777-777777777777";
const CARD_FINGERPRINT = "a".repeat(64);

function saveClaim(
  provider: "square" | "stripe",
  mode: "save_card" | "setup_intent",
  attemptReplay = false,
) {
  return {
    ok: true,
    code: "claimed",
    operation_id: OPERATION,
    attempt_token: ATTEMPT,
    provider_idempotency_key: ATTEMPT,
    attempt_replay: attemptReplay,
    booking_id: BOOKING,
    salon_id: SALON,
    provider,
    mode,
    provider_material: {
      client_name: "QA Guest",
      client_phone: "16045551234",
      client_email: "qa@example.test",
      fee_cents: 2500,
      currency: "CAD",
      salon_name: "QA Salon",
      cancellation_policy: "24 hours",
    },
  };
}

describe("durable card-management provider boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockReset();
    mocks.resolveProvider.mockReset();
    mocks.removeSavedCard.mockReset();
    mocks.saveCardOnFile.mockReset();
    mocks.setupCreate.mockReset();
    mocks.setupRetrieve.mockReset();
    mocks.resolveProvider.mockResolvedValue({
      kind: "square",
      removeSavedCard: mocks.removeSavedCard,
      saveCardOnFile: mocks.saveCardOnFile,
    });
  });

  it("claim failure performs zero provider work", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "database unavailable" } });

    await expect(removeCardWithManagementCapability({
      tokenId: TOKEN,
      requestId: REQUEST,
      expectedCardFingerprint: CARD_FINGERPRINT,
    })).resolves.toEqual({ ok: false, code: "card_management_unavailable" });
    await expect(saveCardWithManagementCapability({
      tokenId: TOKEN,
      requestId: REQUEST,
      provider: "square",
      sourceToken: "cnon:qa",
    })).resolves.toEqual({ ok: false, code: "card_management_unavailable" });
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
    expect(mocks.removeSavedCard).not.toHaveBeenCalled();
    expect(mocks.saveCardOnFile).not.toHaveBeenCalled();
  });

  it("does not redispatch a replayed in-flight card save before reconciliation", async () => {
    mocks.rpc.mockResolvedValue({
      data: saveClaim("square", "save_card", true),
      error: null,
    });

    await expect(saveCardWithManagementCapability({
      tokenId: TOKEN,
      requestId: REQUEST,
      provider: "square",
      sourceToken: "cnon:qa",
    })).resolves.toMatchObject({
      ok: false,
      code: "reconciliation_required",
      bookingId: BOOKING,
      salonId: SALON,
    });
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
    expect(mocks.saveCardOnFile).not.toHaveBeenCalled();
  });

  it("claims removal before the provider and exact replay performs no second provider call", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          code: "claimed",
          operation_id: OPERATION,
          attempt_token: ATTEMPT,
          provider_idempotency_key: ATTEMPT,
          salon_id: SALON,
          provider_material: { card_id: "card_qa", customer_id: "customer_qa" },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { ok: true, code: "removed", booking_id: BOOKING, salon_id: SALON, idempotent: false },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { ok: true, code: "removed", booking_id: BOOKING, salon_id: SALON, idempotent: true },
        error: null,
      });
    mocks.removeSavedCard.mockResolvedValue({ providerReference: "square-card-disabled:card_qa" });

    const input = { tokenId: TOKEN, requestId: REQUEST, expectedCardFingerprint: CARD_FINGERPRINT };
    await expect(removeCardWithManagementCapability(input)).resolves.toMatchObject({ ok: true, code: "removed" });
    await expect(removeCardWithManagementCapability(input)).resolves.toMatchObject({ ok: true, code: "removed", idempotent: true });

    expect(mocks.rpc.mock.calls[0]?.[0]).toBe("claim_booking_card_management_operation");
    expect(mocks.removeSavedCard).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls[1]?.[0]).toBe("complete_booking_card_management_operation");
  });

  it("provider acceptance plus completion loss fails closed and retry does not call the provider again", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          code: "claimed",
          operation_id: OPERATION,
          attempt_token: ATTEMPT,
          provider_idempotency_key: ATTEMPT,
          salon_id: SALON,
          provider_material: { card_id: "card_qa", customer_id: "customer_qa" },
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { message: "response lost" } })
      .mockResolvedValueOnce({ data: { ok: false, code: "in_flight" }, error: null });
    mocks.removeSavedCard.mockResolvedValue({ providerReference: "square-card-disabled:card_qa" });

    const input = { tokenId: TOKEN, requestId: REQUEST, expectedCardFingerprint: CARD_FINGERPRINT };
    await expect(removeCardWithManagementCapability(input)).resolves.toEqual({ ok: false, code: "completion_write_uncertain" });
    await expect(removeCardWithManagementCapability(input)).resolves.toEqual({ ok: false, code: "in_flight", idempotent: undefined, bookingId: undefined, salonId: undefined, finalizeTokenId: undefined, finalizeExpiresAt: undefined, providerReference: undefined });
    expect(mocks.removeSavedCard).toHaveBeenCalledTimes(1);
  });

  it("Stripe setup completion returns a separate final capability and replay retrieves rather than creates", async () => {
    mocks.resolveProvider.mockResolvedValue({ kind: "stripe" });
    mocks.setupCreate.mockResolvedValue({ id: "seti_qa", client_secret: "seti_qa_secret" });
    mocks.setupRetrieve.mockResolvedValue({ id: "seti_qa", client_secret: "seti_qa_secret" });
    const completed = {
      ok: true,
      code: "setup_created",
      booking_id: BOOKING,
      salon_id: SALON,
      provider_reference: "seti_qa",
      finalize_token_id: FINAL_TOKEN,
      finalize_expires_at: "2026-08-21T00:00:00.000Z",
      idempotent: false,
    };
    mocks.rpc
      .mockResolvedValueOnce({ data: saveClaim("stripe", "setup_intent"), error: null })
      .mockResolvedValueOnce({ data: completed, error: null })
      .mockResolvedValueOnce({ data: { ...completed, idempotent: true }, error: null });

    const input = { tokenId: TOKEN, requestId: REQUEST };
    await expect(createStripeSetupWithManagementCapability(input)).resolves.toMatchObject({
      ok: true,
      code: "setup_created",
      finalizeTokenId: FINAL_TOKEN,
      clientSecret: "seti_qa_secret",
    });
    await expect(createStripeSetupWithManagementCapability(input)).resolves.toMatchObject({
      ok: true,
      idempotent: true,
      finalizeTokenId: FINAL_TOKEN,
      clientSecret: "seti_qa_secret",
    });
    expect(mocks.setupCreate).toHaveBeenCalledTimes(1);
    expect(mocks.setupRetrieve).toHaveBeenCalledTimes(1);
  });

  it("final Stripe save uses only the final capability and exact request id", async () => {
    mocks.resolveProvider.mockResolvedValue({
      kind: "stripe",
      saveCardOnFile: mocks.saveCardOnFile,
    });
    mocks.saveCardOnFile.mockResolvedValue({
      cardId: "pm_qa",
      customerId: "cus_qa",
      brand: "visa",
      last4: "4242",
    });
    mocks.rpc
      .mockResolvedValueOnce({ data: saveClaim("stripe", "save_card"), error: null })
      .mockResolvedValueOnce({
        data: { ok: true, code: "saved", booking_id: BOOKING, salon_id: SALON, provider_reference: "pm_qa" },
        error: null,
      });

    await expect(saveCardWithManagementCapability({
      tokenId: FINAL_TOKEN,
      requestId: REQUEST,
      provider: "stripe",
      sourceToken: "pm_qa",
    })).resolves.toMatchObject({ ok: true, code: "saved" });
    expect(mocks.rpc.mock.calls[0]).toEqual([
      "claim_booking_card_save_operation",
      expect.objectContaining({ p_token_id: FINAL_TOKEN, p_request_id: REQUEST, p_provider: "stripe", p_mode: "save_card" }),
    ]);
    expect(mocks.saveCardOnFile).toHaveBeenCalledTimes(1);
  });
});
