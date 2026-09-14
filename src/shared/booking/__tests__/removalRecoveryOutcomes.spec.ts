import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn(), event: vi.fn(), config: vi.fn(), read: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({
  rpc: (name: string, args: unknown) => name === "record_booking_card_removal_recovery_outcome" ? m.event(args) : m.rpc(name, args),
}) }));
vi.mock("@/shared/integrations/square/looseDb", () => ({ looseServiceClient: () => ({}) }));
vi.mock("@/shared/integrations/square/client", () => ({ getSquareConfig: m.config, readSquareCardStateById: m.read }));
import { reconcileBookingCardRemoval } from "../reconcileBookingCardRemoval";
import { CardDeliveryError, cardFailure } from "@/shared/integrations/payments/cardDeliveryFailure";
const id = "11111111-1111-4111-8111-111111111111";
const input = { tokenId: id, requestId: id, expectedCardFingerprint: "a".repeat(64) };
const ctx = { ok: true, code: "recovery_read_required", operation_id: id, source_save_operation_id: null, source_removal_binding_id: id,
  salon_id: id, card_id: "ccof:synthetic", customer_id: "qa_customer", merchant_id: "qa_merchant", environment: "sandbox" };
const card = { cardId: ctx.card_id, customerId: ctx.customer_id, merchantId: ctx.merchant_id, enabled: false, last4: "1111", brand: "VISA" };
const unknown = { ok: false, code: "remove_unknown" };
beforeEach(() => {
  vi.resetAllMocks();
  m.rpc.mockResolvedValueOnce({ data: ctx, error: null }).mockResolvedValue({ data: { ok: true, code: "removed", idempotent: false }, error: null });
  m.event.mockResolvedValue({ data: { ok: true, code: "outcome_recorded" }, error: null });
  m.config.mockResolvedValue({ salonId: id, merchantId: ctx.merchant_id, environment: "sandbox" });m.read.mockResolvedValue(card);
});
function diagnostic(code: string, stage: string, readStatus = "not_requested") {
  expect(m.event).toHaveBeenCalledTimes(1);
  expect(m.event).toHaveBeenCalledWith(expect.objectContaining({ p_token_id: id, p_request_id: id,
    p_card_fingerprint: input.expectedCardFingerprint, p_event_id: expect.stringMatching(/^[a-f0-9-]{36}$/),
    p_code: code, p_stage: stage, p_read_status: readStatus }));
}
describe("removal recovery preserves safe negative outcomes", () => {
  it.each([["expired_or_revoked", "recovery_authority_expired_or_revoked"], ["booking_state_changed", "recovery_state_changed"],
    ["removal_manual_review", "recovery_identity_unavailable"]])("records %s without provider work", async (code, outcome) => {
    m.rpc.mockReset().mockResolvedValue({ data: { ok: false, code }, error: null });
    expect(await reconcileBookingCardRemoval(input)).toEqual(unknown);diagnostic(outcome, "authority");
    expect(m.config).not.toHaveBeenCalled();expect(m.read).not.toHaveBeenCalled();
  });
  it.each(["returned", "thrown"])("context %s error is not missing card", async kind => {
    m.rpc.mockReset();if (kind === "thrown") m.rpc.mockRejectedValue(new Error("secret raw DB error"));
    else m.rpc.mockResolvedValue({ error: { message: "secret raw DB error" } });
    expect(await reconcileBookingCardRemoval(input)).toEqual(unknown);diagnostic("recovery_context_unavailable", "context");expect(m.read).not.toHaveBeenCalled();
  });
  it("malformed or ambiguous identity is a context error", async () => {
    m.rpc.mockReset().mockResolvedValue({ data: { ...ctx, source_save_operation_id: id } });
    expect(await reconcileBookingCardRemoval(input)).toEqual(unknown);diagnostic("recovery_context_invalid", "context");expect(m.config).not.toHaveBeenCalled();
  });
  it("config failure is separate from provider read", async () => {
    m.config.mockRejectedValue(new Error("secret token"));expect(await reconcileBookingCardRemoval(input)).toEqual(unknown);
    diagnostic("square_config_unavailable", "configuration");expect(m.read).not.toHaveBeenCalled();
  });
  it.each([{ merchantId: "other" }, { salonId: "other" }, { environment: "production" }])("config drift %j", async change => {
    m.config.mockResolvedValue({ salonId: id, merchantId: ctx.merchant_id, environment: "sandbox", ...change });
    expect(await reconcileBookingCardRemoval(input)).toEqual(unknown);diagnostic("removal_provider_mismatch", "configuration");expect(m.read).not.toHaveBeenCalled();
  });
  it("network timeout never becomes not found", async () => {
    m.read.mockRejectedValue(Object.assign(new Error("secret response"), { status: 404 }));
    expect(await reconcileBookingCardRemoval(input)).toEqual(unknown);diagnostic("reconciliation_read_failed", "provider_read", "failed");
    expect(m.event.mock.calls[0][0].p_http_status).toBeNull();expect(m.rpc).toHaveBeenCalledTimes(1);
  });
  it("explicit 404 is recorded but cannot clear a card or authorize mutation", async () => {
    m.read.mockRejectedValue(new CardDeliveryError({ stage: "reconciliation", code: "reconciliation_read_failed", httpStatus: 404,
      squareCodes: ["NOT_FOUND"], squareCategories: ["INVALID_REQUEST_ERROR"], retryability: "reconcile_first" }));
    expect(await reconcileBookingCardRemoval(input)).toEqual(unknown);diagnostic("reconciliation_not_found", "provider_read", "failed");
    expect(m.event.mock.calls[0][0]).toMatchObject({ p_http_status: 404, p_square_codes: ["NOT_FOUND"], p_retryability: "manual_review" });expect(m.rpc).toHaveBeenCalledTimes(1);
  });
  it("invalid provider receipt preserves observed HTTP status", async () => {
    m.read.mockRejectedValue(cardFailure("reconciliation", "reconciliation_invalid_card", "manual_review", 200));
    expect(await reconcileBookingCardRemoval(input)).toEqual(unknown);diagnostic("reconciliation_invalid_card", "provider_read", "invalid_receipt");
    expect(m.event.mock.calls[0][0].p_http_status).toBe(200);
  });
  it.each([{ enabled: undefined }, { cardId: "wrong" }, { customerId: "wrong" }, { last4: "123" }, { brand: "" }])("malformed card %j cannot complete", async change => {
    m.read.mockResolvedValue({ ...card, ...change });expect(await reconcileBookingCardRemoval(input)).toEqual(unknown);
    diagnostic("reconciliation_invalid_card", "provider_read", "invalid_receipt");expect(m.rpc).toHaveBeenCalledTimes(1);
  });
  it("valid active card is a completed read, not a failed read or removed receipt", async () => {
    m.read.mockResolvedValue({ ...card, enabled: true });expect(await reconcileBookingCardRemoval(input)).toEqual(unknown);
    diagnostic("reconciliation_card_active", "provider_read", "completed");expect(m.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(["returned", "thrown"])("completion %s loss remains uncertain", async kind => {
    m.rpc.mockReset().mockResolvedValueOnce({ data: ctx });
    if (kind === "thrown") m.rpc.mockRejectedValue(new Error("secret DB error"));else m.rpc.mockResolvedValue({ error: {} });
    expect(await reconcileBookingCardRemoval(input)).toEqual({ ok: false, code: "completion_write_uncertain" });
    diagnostic("database_completion_uncertain", "database_completion", "completed");expect(m.read).toHaveBeenCalledTimes(1);
  });
  it("completion rejection is distinct from response loss", async () => {
    m.rpc.mockReset().mockResolvedValueOnce({ data: ctx }).mockResolvedValue({ data: { ok: false, code: "booking_state_changed" } });
    expect(await reconcileBookingCardRemoval(input)).toEqual(unknown);diagnostic("recovery_completion_rejected", "database_completion", "completed");
  });
  it("typed provider errors are re-sanitized and never logged", async () => {
    const error = new CardDeliveryError({ stage: "reconciliation", code: "raw_email@example.invalid", httpStatus: 999,
      squareCodes: ["FORBIDDEN", "FORBIDDEN", "source_secret"], squareCategories: ["AUTHENTICATION_ERROR", "phone_secret"], retryability: "reconcile_first" });
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    try {
      m.read.mockRejectedValue(error);expect(await reconcileBookingCardRemoval(input)).toEqual(unknown);
      expect(m.event.mock.calls[0][0]).toMatchObject({ p_http_status: null, p_square_codes: ["FORBIDDEN"], p_square_categories: ["AUTHENTICATION_ERROR"] });
      expect(JSON.stringify(m.event.mock.calls)).not.toMatch(/source_secret|phone_secret|raw_email|qa_customer|ccof:synthetic|qa_merchant/);
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally { for (const log of logs) log.mockRestore(); }
  });
  it.each(["returned", "thrown"])("diagnostic write %s failure cannot turn unknown into success or dispatch", async kind => {
    m.read.mockRejectedValue(new Error("timeout"));
    if (kind === "thrown") m.event.mockRejectedValue(new Error("secret DB"));else m.event.mockResolvedValue({ error: {} });
    expect(await reconcileBookingCardRemoval(input)).toEqual(unknown);expect(m.read).toHaveBeenCalledTimes(1);expect(m.rpc).toHaveBeenCalledTimes(1);
  });
  it("separate recovery reads have separate event IDs", async () => {
    m.rpc.mockReset().mockResolvedValue({ data: ctx });m.read.mockRejectedValue(new Error("timeout"));
    await reconcileBookingCardRemoval(input);await reconcileBookingCardRemoval(input);
    expect(m.event).toHaveBeenCalledTimes(2);expect(m.event.mock.calls[0][0].p_event_id).not.toBe(m.event.mock.calls[1][0].p_event_id);
  });
  it("positive recovery uses durable receipt without adding negative history", async () => {
    expect((await reconcileBookingCardRemoval(input)).ok).toBe(true);expect(m.event).not.toHaveBeenCalled();
  });
  it("invalid request is rejected without diagnostic writes", async () => {
    expect((await reconcileBookingCardRemoval({ ...input, tokenId: "bad" })).code).toBe("invalid_request");expect(m.rpc).not.toHaveBeenCalled();expect(m.event).not.toHaveBeenCalled();
  });
});
