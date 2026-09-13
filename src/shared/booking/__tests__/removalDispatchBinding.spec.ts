import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn(), resolve: vi.fn(), reconcile: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({ rpc: m.rpc }) }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: m.resolve }));
vi.mock("@/shared/booking/reconcileBookingCardRemoval", () => ({ reconcileBookingCardRemoval: m.reconcile }));
import { SquareProvider } from "@/shared/integrations/payments/square";
import { StripeProvider } from "@/shared/integrations/payments/stripe";
import type { SquareConfig } from "@/shared/integrations/square/client";
import type Stripe from "stripe";
import { removeCardWithManagementCapability } from "../bookingCardManagement";
const id = "11111111-1111-4111-8111-111111111111";
const cfg: SquareConfig = { salonId: id, merchantId: "merchant_qa", locationId: "location_qa",
  environment: "sandbox", accessToken: "synthetic-secret", applicationId: "sandbox-app", currency: "CAD",
  sync: { pullCreate: false, pullUpdate: false, pullCancel: false, pushCreate: false, pushUpdate: false, pushCancel: false } };
const input = { tokenId: id, requestId: id, expectedCardFingerprint: "a".repeat(64) };
const card = { id: "ccof:synthetic", customer_id: "customer_qa", merchant_id: cfg.merchantId,
  enabled: true, card_brand: "VISA", last_4: "1111" };
let events: string[];
beforeEach(() => {
  vi.resetAllMocks(); events = [];
  m.resolve.mockResolvedValue(new SquareProvider(cfg));
  m.rpc.mockImplementation(async (name: string) => {
    events.push(name);
    return { error: null, data: name === "claim_booking_card_management_operation"
      ? { ok: true, code: "claimed", operation_id: id, attempt_token: id, provider_idempotency_key: id, salon_id: id,
        provider_material: { card_id: card.id, customer_id: card.customer_id } }
      : name === "prepare_booking_card_removal_dispatch"
        ? { ok: true, code: "removal_dispatch_prepared", idempotent: false }
        : { ok: true, code: "removed" } };
  });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    events.push(String(init.method));
    return new Response(JSON.stringify({ card: { ...card, enabled: init.method === "GET" } }), { status: 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());
describe("durable Square removal preparation boundary", () => {
  it("records minimal identity before GET and DisableCard", async () => {
    expect((await removeCardWithManagementCapability(input)).ok).toBe(true);
    expect(events).toEqual(["claim_booking_card_management_operation", "prepare_booking_card_removal_dispatch", "GET", "POST", "complete_booking_card_management_operation"]);
    expect(m.rpc).toHaveBeenCalledWith("prepare_booking_card_removal_dispatch", {
      p_operation_id: id, p_attempt_token: id, p_provider: "square", p_merchant_id: "merchant_qa", p_environment: "sandbox",
    });
  });
  it.each(["removal_provider_mismatch", "expired_or_revoked", "claim_mismatch", "invalid_provider_identity"])("%s prevents all provider work and preserves sending", async code => {
    const original = m.rpc.getMockImplementation()!;
    m.rpc.mockImplementation(async (...args) => args[0] === "prepare_booking_card_removal_dispatch"
      ? { data: { ok: false, code }, error: null } : original(...args));
    expect(await removeCardWithManagementCapability(input)).toEqual({ ok: false, code: "removal_dispatch_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    expect(m.rpc.mock.calls.some(([name]) => name === "complete_booking_card_management_operation")).toBe(false);
  });
  it.each(["return_error", "response_loss", "malformed_ack"])("%s cannot authorize a provider request", async failure => {
    const original = m.rpc.getMockImplementation()!;
    m.rpc.mockImplementation(async (...args) => {
      if (args[0] !== "prepare_booking_card_removal_dispatch") return original(...args);
      if (failure === "response_loss") throw new Error("synthetic DB loss");
      return failure === "return_error" ? { data: null, error: { code: "57014" } } : { data: { ok: true }, error: null };
    });
    expect((await removeCardWithManagementCapability(input)).code).toBe("removal_dispatch_unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("Stripe cannot bypass a denied Square binding through its read fallback", async () => {
    const retrieve = vi.fn(), detach = vi.fn();
    m.resolve.mockResolvedValue(new StripeProvider({ paymentMethods: { retrieve, detach } } as unknown as Stripe));
    const original = m.rpc.getMockImplementation()!;
    m.rpc.mockImplementation(async (...args) => args[0] === "prepare_booking_card_removal_dispatch"
      ? { data: { ok: false, code: "removal_provider_mismatch" }, error: null } : original(...args));
    expect((await removeCardWithManagementCapability(input)).code).toBe("removal_dispatch_unavailable");
    expect(retrieve).not.toHaveBeenCalled(); expect(detach).not.toHaveBeenCalled();
  });
});

describe("Square removal concurrent dispatch", () => {
  it.each([false, true])("serialized=%s: respects the durable authorization with simultaneous enabled reads", async serialized => {
    const original = m.rpc.getMockImplementation()!;
    let preparations = 0;
    let release!: () => void;
    const bothPrepared = new Promise<void>(resolve => { release = resolve; });
    m.rpc.mockImplementation(async (...args) => {
      if (args[0] !== "prepare_booking_card_removal_dispatch") return original(...args);
      preparations += 1;
      if (preparations === 2) release();
      return { error: null, data: serialized && preparations > 1
        ? { ok: false, code: "removal_dispatch_in_progress" }
        : { ok: true, code: "removal_dispatch_prepared" } };
    });
    const transport = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (args[1]?.method === "GET") await bothPrepared;
      return transport(...args);
    });
    const results = await Promise.all([removeCardWithManagementCapability(input), removeCardWithManagementCapability(input)]);
    expect(events.filter(e => e === "POST")).toHaveLength(serialized ? 1 : 2);
    expect(results.filter(r => r.code === "in_flight")).toHaveLength(serialized ? 1 : 0);
    expect(events.filter(e => e === "complete_booking_card_management_operation")).toHaveLength(serialized ? 1 : 2);
    expect(events).not.toContain("record_booking_card_removal_delivery_failure");
  });
  it("stale dispatch acknowledgment permits only read-only recovery", async () => {
    const original = m.rpc.getMockImplementation()!;
    m.rpc.mockImplementation(async (...args) => args[0] === "prepare_booking_card_removal_dispatch"
      ? { error: null, data: { ok: false, code: "remove_unknown" } } : original(...args));
    m.reconcile.mockResolvedValue({ ok: true, code: "removed", idempotent: true });
    expect(await removeCardWithManagementCapability(input)).toEqual({ ok: true, code: "removed", idempotent: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(m.reconcile).toHaveBeenCalledExactlyOnceWith(input);
    expect(events).not.toContain("complete_booking_card_management_operation");
    expect(events).not.toContain("record_booking_card_removal_delivery_failure");
  });
  it("lost preparation acknowledgment never permits a later provider dispatch", async () => {
    const original = m.rpc.getMockImplementation()!;
    let prepared = false;
    m.rpc.mockImplementation(async (...args) => {
      if (args[0] !== "prepare_booking_card_removal_dispatch") return original(...args);
      if (!prepared) { prepared = true; throw new Error("synthetic lost acknowledgment"); }
      return { error: null, data: { ok: false, code: "removal_dispatch_in_progress" } };
    });
    expect((await removeCardWithManagementCapability(input)).code).toBe("removal_dispatch_unavailable");
    expect((await removeCardWithManagementCapability(input)).code).toBe("in_flight");
    expect(fetch).not.toHaveBeenCalled();
    expect(events).not.toContain("complete_booking_card_management_operation");
    expect(events.filter(e => e === "record_booking_card_removal_delivery_failure")).toHaveLength(1);
  });
  it("configuration failure before preparation still allows one later dispatch", async () => {
    m.resolve.mockRejectedValueOnce(new Error("synthetic read failure"));
    expect((await removeCardWithManagementCapability(input)).code).toBe("card_management_unavailable");
    expect(fetch).not.toHaveBeenCalled();
    expect((await removeCardWithManagementCapability(input)).ok).toBe(true);
    expect(events.filter(e => e === "POST")).toHaveLength(1);
  });
});
