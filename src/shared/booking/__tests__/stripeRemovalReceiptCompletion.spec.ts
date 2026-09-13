import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), provider: vi.fn(), retrieve: vi.fn(), detach: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({ rpc: (name: string, args: unknown) => name === "record_booking_card_removal_delivery_failure"
  ? Promise.resolve({data:{ok:true,code:"failure_recorded"},error:null}) : name === "prepare_booking_card_removal_dispatch"
  ? Promise.resolve({ data: { ok: true, code: "removal_dispatch_prepared" }, error: null }) : mocks.rpc(name, args) }) }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: mocks.provider }));
import { StripeProvider } from "@/shared/integrations/payments/stripe";
import { removeCardWithManagementCapability } from "../bookingCardManagement";
const operation = "22222222-2222-4222-8222-222222222222";
const attempt = "33333333-3333-4333-8333-333333333333";
const input = { tokenId: operation, requestId: attempt, expectedCardFingerprint: "a".repeat(64) };
const cardId = "pm_synthetic_card";
const customerId = "cus_synthetic_owner";
const pm = (customer: string | null) => ({ id: cardId, object: "payment_method", type: "card", customer });
const claim = (replay = false) => ({ ok: true, code: "claimed", operation_id: operation, attempt_token: attempt,
  salon_id: "11111111-1111-4111-8111-111111111111", provider_idempotency_key: operation, attempt_replay: replay,
  provider_material: { card_id: cardId, customer_id: customerId } });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in unit test"); }));
  mocks.provider.mockResolvedValue(new StripeProvider({ paymentMethods: { retrieve: mocks.retrieve, detach: mocks.detach } } as unknown as Stripe));
  mocks.retrieve.mockResolvedValue(pm(customerId));
  mocks.detach.mockResolvedValue(pm(null));
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === "claim_booking_card_management_operation"
    ? { data: claim(), error: null }
    : { data: { ok: args.p_outcome === "succeeded", code: args.p_outcome === "succeeded" ? "removed" : "remove_unknown" }, error: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("Stripe removal receipt reaches durable completion", () => {
  it("matching detached receipt completes succeeded", async () => {
    expect(await removeCardWithManagementCapability(input)).toMatchObject({ ok: true, code: "removed" });
    expect(mocks.rpc).toHaveBeenLastCalledWith("complete_booking_card_management_operation", expect.objectContaining({ p_outcome: "succeeded", p_provider_reference: cardId }));
  });
  it("invalid receipt and inconclusive read complete unknown", async () => {
    mocks.detach.mockResolvedValue({ id: cardId });
    expect(await removeCardWithManagementCapability(input)).toMatchObject({ ok: false, code: "remove_unknown" });
    expect(mocks.rpc).toHaveBeenLastCalledWith("complete_booking_card_management_operation", expect.objectContaining({ p_outcome: "unknown", p_provider_reference: null }));
  });
  it("another customer's card is not detached or recorded as success", async () => {
    mocks.retrieve.mockResolvedValue(pm("cus_other"));
    expect(await removeCardWithManagementCapability(input)).toMatchObject({ ok: false, code: "remove_unknown" });
    expect(mocks.detach).not.toHaveBeenCalled();
  });
  it("lost detach response is recovered by read before completion", async () => {
    mocks.detach.mockRejectedValue(new Error("synthetic loss"));
    mocks.retrieve.mockResolvedValueOnce(pm(customerId)).mockResolvedValueOnce(pm(null));
    expect(await removeCardWithManagementCapability(input)).toMatchObject({ ok: true, code: "removed" });
    expect(mocks.detach).toHaveBeenCalledTimes(1);
    expect(mocks.retrieve).toHaveBeenCalledTimes(2);
  });
  it.each(["returned_error", "thrown_error"])("DB completion %s is uncertain and sending replay does not detach again", async (failure) => {
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValueOnce({ data: claim(), error: null });
    if (failure === "returned_error") mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "57014" } });
    else mocks.rpc.mockRejectedValueOnce(new Error("synthetic database response loss"));
    mocks.rpc.mockResolvedValueOnce({ data: claim(true), error: null })
      .mockResolvedValueOnce({ data: { ok: true, code: "removed" }, error: null });
    mocks.detach.mockImplementation(async () => { mocks.retrieve.mockResolvedValue(pm(null)); return pm(null); });
    expect(await removeCardWithManagementCapability(input)).toEqual({ ok: false, code: "completion_write_uncertain" });
    expect(await removeCardWithManagementCapability(input)).toMatchObject({ ok: true, code: "removed" });
    expect(mocks.detach).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "complete_booking_card_management_operation")
      .map(([, args]) => [args.p_operation_id, args.p_outcome])).toEqual([[operation, "succeeded"], [operation, "succeeded"]]);
  });
  it("terminal unknown replay makes no provider call and is not a recovery proof", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, code: "remove_unknown", idempotent: true }, error: null });
    expect(await removeCardWithManagementCapability(input)).toMatchObject({ ok: false, code: "remove_unknown" });
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.detach).not.toHaveBeenCalled();
  });
});
