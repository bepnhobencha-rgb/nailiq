import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), provider: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: mocks.provider }));
vi.mock("@/shared/booking/cardCapturePause", () => ({ isCardCapturePaused: () => false }));
vi.mock("@/shared/release/v1IntegrationScope", () => ({ v1AllowsNoShowCardOnFile: () => true }));
vi.mock("@/shared/security/sameOriginMutation", () => ({ isSameOriginMutation: () => true }));
vi.mock("@/shared/booking/bookingManagementRateLimit", () => ({ consumeBookingManagementRateLimit: async () => "allowed" }));
import { POST } from "@/app/api/booking/square-save-card/route";
const body = { token: "11111111-1111-4111-8111-111111111111", requestId: "22222222-2222-4222-8222-222222222222", sourceId: "synthetic_source", provider: "square", consent: true };
function request(extra = {}) { return new Request("https://qa.example/api/booking/square-save-card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, ...extra }) }); }
describe("durable card save HTTP truth", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it.each([
    [{ ok: false, code: "save_failed", failure_kind: "card_rejected", idempotent: true }, 422],
    [{ ok: false, code: "save_failed" }, 503],
    [{ ok: false, code: "reconciliation_required" }, 503],
    [{ ok: false, code: "database_completion_uncertain" }, 503],
    [{ ok: false, code: "card_management_unavailable" }, 503],
    [{ ok: false, code: "in_flight" }, 409],
    [{ ok: false, code: "idempotency_mismatch" }, 409],
    [{ ok: false, code: "expired_or_revoked" }, 404],
    [{ ok: true, code: "saved", idempotent: true }, 200],
  ])("replayed receipt %j returns HTTP %i without provider work", async (receipt, status) => {
    mocks.rpc.mockResolvedValue({ data: receipt, error: null });
    for (let i = 0; i < 2; i++) {
      const response = await POST(request());
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const result = await response.json();
      expect(result.code).toBe(receipt.code);
      if (status === 422) expect(result.failureKind).toBe("card_rejected");
    }
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.every(([name]) => name === "claim_booking_card_save_operation")).toBe(true);
  });
  it("cannot turn server uncertainty into rejection using a client-supplied field", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, code: "save_failed" }, error: null });
    const response = await POST(request({ failureKind: "card_rejected", failure_kind: "card_rejected" }));
    expect(response.status).toBe(503); expect((await response.json()).failureKind).toBeUndefined();
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it.each([
    { ok: true, code: "saved", failure_kind: "card_rejected" },
    { ok: false, code: "reconciliation_required", failure_kind: "card_rejected" },
    { ok: false, code: "save_failed", failure_kind: "unexpected" },
  ])("rejects inconsistent classification %j", async receipt => {
    mocks.rpc.mockResolvedValue({ data: receipt, error: null });
    const response = await POST(request()); expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("invalid_card_operation_response");
    expect(mocks.provider).not.toHaveBeenCalled();
  });
});
