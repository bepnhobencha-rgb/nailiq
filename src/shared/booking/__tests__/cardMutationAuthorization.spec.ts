import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), provider: vi.fn(), stripe: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: mocks.provider }));
vi.mock("@/shared/lib/stripe", () => ({ getStripeClient: mocks.stripe }));
import { removeCardWithManagementCapability, saveCardWithManagementCapability, createStripeSetupWithManagementCapability } from "../bookingCardManagement";

const tokenId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const callers = [
  ["remove", () => removeCardWithManagementCapability({ tokenId, requestId, expectedCardFingerprint: "a".repeat(64) }), "claim_booking_card_management_operation"],
  ["save", () => saveCardWithManagementCapability({ tokenId, requestId, provider: "square", sourceToken: "synthetic-never-dispatched" }), "claim_booking_card_save_operation"],
  ["setup", () => createStripeSetupWithManagementCapability({ tokenId, requestId }), "claim_booking_card_save_operation"],
] as const;
beforeEach(() => {
  vi.clearAllMocks();
  // Exercise authorization independently of the release pause. This affects
  // only mocked local dependencies, never QA/Production configuration.
  vi.stubEnv("NAILIQ_CARD_SAVE_DISPATCH_DISABLED", "false");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in authorization unit tests"); }));
  mocks.provider.mockImplementation(() => { throw new Error("Unexpected provider resolution"); });
  mocks.stripe.mockImplementation(() => { throw new Error("Unexpected Stripe resolution"); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe.each(callers)("%s mutation authorization before provider dispatch", (_name, invoke, claimRpc) => {
  it.each(["invalid_token", "expired_or_revoked", "stale_epoch", "stale_card", "booking_state_changed", "operation_conflict", "idempotency_mismatch", "in_flight", "reconciliation_required"])("denied claim %s performs zero provider work", async code => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, code }, error: null });
    expect(await invoke()).toMatchObject({ ok: false, code });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls[0][0]).toBe(claimRpc);
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_token_id: tokenId, p_request_id: requestId });
    expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.stripe).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([null, { ok: true, code: "claimed" }])("malformed claim cannot authorize dispatch", async data => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    expect(await invoke()).toMatchObject({ ok: false, code: "invalid_card_operation_response" });
    expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.stripe).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("database failure does not resolve a provider or disclose its error details", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "synthetic-private-database-detail" } });
    expect(await invoke()).toEqual({ ok: false, code: "card_management_unavailable" });
    expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.stripe).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
