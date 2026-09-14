import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), provider: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({ rpc: (name: string, args: unknown) => name === "record_booking_card_removal_delivery_failure"
  ? Promise.resolve({data:{ok:true,code:"failure_recorded"},error:null}) : name === "prepare_booking_card_removal_dispatch"
  ? Promise.resolve({ data: { ok: true, code: "removal_dispatch_prepared" }, error: null }) : mocks.rpc(name, args) }) }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: mocks.provider }));
import { SquareProvider } from "@/shared/integrations/payments/square";
import type { SquareConfig } from "@/shared/integrations/square/client";
import { removeCardWithManagementCapability } from "../bookingCardManagement";
const cfg: SquareConfig = { salonId: "11111111-1111-4111-8111-111111111111", merchantId: "merchant_qa", locationId: "location_qa",
  accessToken: "synthetic-access", applicationId: "sandbox-app", environment: "sandbox", currency: "CAD",
  sync: { pullCreate: false, pullUpdate: false, pullCancel: false, pushCreate: false, pushUpdate: false, pushCancel: false } };
const operation = "22222222-2222-4222-8222-222222222222";
const attempt = "33333333-3333-4333-8333-333333333333";
const input = { tokenId: operation, requestId: attempt, expectedCardFingerprint: "a".repeat(64) };
const cardId = "ccof:synthetic-card";
const claim = (replay = false) => ({ ok: true, code: "claimed", operation_id: operation, attempt_token: attempt,
  salon_id: cfg.salonId, provider_idempotency_key: operation, attempt_replay: replay,
  provider_material: { card_id: cardId, customer_id: "synthetic-customer" } });
const disabled = { card: { id: cardId, enabled: false } };
const active = { card: { id: cardId, enabled: true, customer_id: "synthetic-customer",
  merchant_id: cfg.merchantId, card_brand: "VISA", last_4: "1111" } };
function transport(...values: Array<object | Error>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(`https://connect.squareupsandbox.com/v2/cards/${encodeURIComponent(cardId)}${init.method === "POST" ? "/disable" : ""}`);
    calls.push(String(init.method)); const value = values.shift();
    if (value instanceof Error) throw value;
    if (!value) throw new Error("Unexpected provider call");
    return new Response(JSON.stringify(value), { status: 200 });
  }));
  return calls;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.rpc.mockReset(); mocks.provider.mockResolvedValue(new SquareProvider(cfg));
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === "claim_booking_card_management_operation"
    ? { data: claim(), error: null }
    : { data: { ok: args.p_outcome === "succeeded", code: args.p_outcome === "succeeded" ? "removed" : "remove_unknown" }, error: null });
});
afterEach(() => vi.unstubAllGlobals());
describe("Square receipt validation reaches durable removal completion", () => {
  it("malformed success and inconclusive read complete unknown, never succeeded", async () => {
    const calls = transport(active, {}, { card: { id: cardId, enabled: true } });
    expect(await removeCardWithManagementCapability(input)).toMatchObject({ ok: false, code: "remove_unknown" });
    expect(calls).toEqual(["GET", "POST", "GET"]);
    expect(mocks.rpc).toHaveBeenLastCalledWith("complete_booking_card_management_operation", expect.objectContaining({ p_outcome: "unknown", p_provider_reference: null }));
  });
  it("lost response with a matching disabled read completes succeeded", async () => {
    const calls = transport(active, new Error("synthetic response loss"), disabled);
    expect(await removeCardWithManagementCapability(input)).toMatchObject({ ok: true, code: "removed" });
    expect(calls).toEqual(["GET", "POST", "GET"]);
    expect(mocks.rpc).toHaveBeenLastCalledWith("complete_booking_card_management_operation", expect.objectContaining({ p_outcome: "succeeded", p_provider_reference: cardId }));
  });
  it("DB completion loss replays with a bound read and no second DisableCard", async () => {
    mocks.rpc.mockReset(); mocks.rpc
      .mockResolvedValueOnce({ data: claim(), error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "57014" } })
      .mockResolvedValueOnce({ data: claim(true), error: null })
      .mockResolvedValueOnce({ data: { ok: true, code: "removed" }, error: null });
    const calls = transport(active, disabled, { card: { ...active.card, enabled: false } });
    expect(await removeCardWithManagementCapability(input)).toEqual({ ok: false, code: "completion_write_uncertain" });
    expect(await removeCardWithManagementCapability(input)).toMatchObject({ ok: true, code: "removed" });
    expect(calls).toEqual(["GET", "POST", "GET"]);
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "complete_booking_card_management_operation").map(([, args]) => args.p_operation_id)).toEqual([operation, operation]);
  });
  it("a terminal unknown replay performs no further provider request", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, code: "remove_unknown", idempotent: true }, error: null });
    const calls = transport();
    expect(await removeCardWithManagementCapability(input)).toMatchObject({ ok: false, code: "remove_unknown", idempotent: true });
    expect(calls).toEqual([]); expect(mocks.provider).not.toHaveBeenCalled();
  });
});
