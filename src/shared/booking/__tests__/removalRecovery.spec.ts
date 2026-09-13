import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn(), event: vi.fn(), config: vi.fn(), read: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({ rpc: (name: string, args: unknown) => name === "record_booking_card_removal_recovery_outcome" ? m.event(args) : m.rpc(name, args) }) }));
vi.mock("@/shared/integrations/square/looseDb", () => ({ looseServiceClient: () => ({}) }));
vi.mock("@/shared/integrations/square/client", () => ({ getSquareConfig: m.config, readSquareCardStateById: m.read }));
import { reconcileBookingCardRemoval } from "../reconcileBookingCardRemoval";
const id = "11111111-1111-4111-8111-111111111111";
const input = { tokenId: id, requestId: id, expectedCardFingerprint: "a".repeat(64) };
const ctx = { ok: true, code: "recovery_read_required", operation_id: id, source_save_operation_id: id,
  salon_id: id, card_id: "ccof:synthetic", customer_id: "customer_qa", merchant_id: "merchant_qa", environment: "sandbox" };
const card = { cardId: ctx.card_id, customerId: ctx.customer_id, merchantId: ctx.merchant_id,
  enabled: false, last4: "1111", brand: "VISA" };
beforeEach(() => {
  vi.resetAllMocks();
  m.rpc.mockResolvedValueOnce({ data: ctx, error: null }).mockResolvedValue({ data: { ok: true, code: "removed", idempotent: false }, error: null });
  m.config.mockResolvedValue({ salonId: id, merchantId: ctx.merchant_id, environment: "sandbox" });
  m.read.mockResolvedValue(card);
});
describe("unknown removal positive recovery", () => {
  it("uses a frozen removal binding without a historical save receipt", async () => {
    m.rpc.mockReset().mockResolvedValueOnce({ data: { ...ctx, source_save_operation_id: null, source_removal_binding_id: id }, error: null })
      .mockResolvedValue({ data: { ok: true, code: "removed", idempotent: false }, error: null });
    expect((await reconcileBookingCardRemoval(input)).ok).toBe(true);
    expect(m.rpc).toHaveBeenLastCalledWith("complete_booking_card_removal_recovery", expect.objectContaining({
      p_receipt: expect.objectContaining({ source_save_operation_id: null, source_removal_binding_id: id }),
    }));
  });
  it.each([
    { source_save_operation_id: id, source_removal_binding_id: id },
    { source_save_operation_id: null, source_removal_binding_id: null },
    { source_save_operation_id: null, source_removal_binding_id: "22222222-2222-4222-8222-222222222222" },
  ])("rejects ambiguous/missing/wrong source %j", async source => {
    m.rpc.mockReset().mockResolvedValue({ data: { ...ctx, ...source }, error: null });
    expect((await reconcileBookingCardRemoval(input)).ok).toBe(false); expect(m.read).not.toHaveBeenCalled();
  });
  it("reads the bound card and completes with a minimal receipt", async () => {
    expect(await reconcileBookingCardRemoval(input)).toEqual({ ok: true, code: "removed", idempotent: false });
    expect(m.read).toHaveBeenCalledExactlyOnceWith(expect.anything(), ctx.card_id, ctx.customer_id);
    expect(m.rpc).toHaveBeenLastCalledWith("complete_booking_card_removal_recovery", expect.objectContaining({
      p_receipt: { operation_id: id, source_save_operation_id: id, card_id: card.cardId,
        customer_id: card.customerId, merchant_id: card.merchantId, environment: "sandbox", enabled: false, brand: "VISA", last4: "1111" },
    }));
  });
  it("successful receipt replay makes no provider read", async () => {
    m.rpc.mockReset().mockResolvedValue({ data: { ok: true, code: "removed", idempotent: true }, error: null });
    expect(await reconcileBookingCardRemoval(input)).toEqual({ ok: true, code: "removed", idempotent: true });
    expect(m.config).not.toHaveBeenCalled(); expect(m.read).not.toHaveBeenCalled();
  });
  it.each(["expired_or_revoked", "invalid_request", "removal_manual_review", "booking_state_changed"])("%s does not read provider", async code => {
    m.rpc.mockReset().mockResolvedValue({ data: { ok: false, code }, error: null });
    expect(await reconcileBookingCardRemoval(input)).toEqual({ ok: false, code: "remove_unknown" });
    expect(m.config).not.toHaveBeenCalled();
  });
  it.each([{ merchantId: "other" }, { environment: "production" }, { salonId: "other" }])("config drift %j prevents read", async change => {
    m.config.mockResolvedValue({ salonId: id, merchantId: ctx.merchant_id, environment: "sandbox", ...change });
    expect((await reconcileBookingCardRemoval(input)).ok).toBe(false); expect(m.read).not.toHaveBeenCalled();
  });
  it.each([{ enabled: true }, { enabled: undefined }, { cardId: "other" }, { customerId: "other" },
    { merchantId: "other" }, { last4: "123" }])("unproven removal %j never completes", async change => {
    m.read.mockResolvedValue({ ...card, ...change });
    expect((await reconcileBookingCardRemoval(input)).ok).toBe(false); expect(m.rpc).toHaveBeenCalledTimes(1);
  });
  it("provider read failure is not card-not-found or completion", async () => {
    m.read.mockRejectedValue(new Error("synthetic timeout"));
    expect(await reconcileBookingCardRemoval(input)).toEqual({ ok: false, code: "remove_unknown" });
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });
  it("configuration failure makes no provider read", async () => {
    m.config.mockRejectedValue(new Error("synthetic config failure"));
    expect((await reconcileBookingCardRemoval(input)).ok).toBe(false); expect(m.read).not.toHaveBeenCalled();
  });
  it("completion response loss remains uncertain", async () => {
    m.rpc.mockReset().mockResolvedValueOnce({ data: ctx, error: null }).mockRejectedValueOnce(new Error("DB loss"));
    expect(await reconcileBookingCardRemoval(input)).toEqual({ ok: false, code: "completion_write_uncertain" });
    expect(m.read).toHaveBeenCalledTimes(1);
  });
  it("malformed binding makes no provider/config call", async () => {
    m.rpc.mockReset().mockResolvedValue({ data: { ...ctx, source_save_operation_id: "invalid" }, error: null });
    expect((await reconcileBookingCardRemoval(input)).ok).toBe(false); expect(m.config).not.toHaveBeenCalled();
  });
  it("invalid request is rejected before DB", async () => {
    expect((await reconcileBookingCardRemoval({ ...input, tokenId: "bad" })).code).toBe("invalid_request");
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
