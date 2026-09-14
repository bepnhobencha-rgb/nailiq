import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), config: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/shared/integrations/square/looseDb", () => ({ looseServiceClient: () => ({}) }));
vi.mock("@/shared/integrations/square/client", async (original) => ({
  ...await original<typeof import("@/shared/integrations/square/client")>(),
  getSquareConfig: mocks.config,
}));
import { reconcileBookingCardSaveOperations } from "../reconcileBookingCardSaveOperations";

const operation = "11111111-1111-4111-8111-111111111111";
const reference = `nq-card:${operation}`;
const due = {
  operation_id: operation, attempt_token: "22222222-2222-4222-8222-222222222222",
  salon_id: "33333333-3333-4333-8333-333333333333", provider: "square",
  provider_reference_key: reference, expected_customer_id: "customer_qa",
  expected_merchant_id: "merchant_qa", expected_environment: "sandbox",
};
const receipt = { id: "card_qa", customer_id: "customer_qa", merchant_id: "merchant_qa",
  reference_id: reference, enabled: true, card_brand: "VISA", last_4: "1111" };

function transport(...pages: Array<Response | Error>) {
  const fetcher = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe("https://connect.squareupsandbox.com");
    expect(url.pathname).toBe("/v2/cards");
    expect(url.searchParams.get("reference_id")).toBe(reference);
    expect(url.searchParams.get("include_disabled")).toBe("true");
    expect(init.method).toBe("GET");
    const page = pages.shift();
    if (page instanceof Error) throw page;
    if (!page) throw new Error("unexpected read");
    return page;
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const page = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const completions = () => mocks.rpc.mock.calls.filter(([name]) => name === "complete_booking_card_save_reconciliation");
const failures = () => mocks.rpc.mock.calls.filter(([name]) => name === "record_booking_card_delivery_failure");

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockResolvedValue({ merchantId: "merchant_qa", environment: "sandbox", accessToken: "PRIVATE_FAKE_KEY" });
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "claim_booking_card_save_reconciliation") return { data: due, error: null };
    return { data: { ok: true, code: args.p_outcome === "found" ? "reconciled_saved" : "reconciliation_pending" }, error: null };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("real Square read/parser through reconciliation worker, simulated transport and database", () => {
  it.each([
    ["empty", [], "not_found", 0],
    ["one valid", [receipt], "found", 1],
    ["multiple", [receipt, { ...receipt, id: "card_second" }], "multiple_matches", 0],
    ["disabled", [{ ...receipt, enabled: false }], "disabled_card", 0],
    ["missing last4", [{ ...receipt, last_4: null }], "invalid_card", 0],
    ["wrong customer", [{ ...receipt, customer_id: "foreign" }], "invalid_card", 0],
    ["wrong merchant", [{ ...receipt, merchant_id: "foreign" }], "invalid_card", 0],
    ["wrong reference", [{ ...receipt, reference_id: "foreign" }], "invalid_card", 0],
  ])("%s produces the exact outcome without any mutation", async (_label, cards, outcome, reconciled) => {
    const fetcher = transport(page({ cards }));
    const result = await reconcileBookingCardSaveOperations(1, operation);
    expect(result).toMatchObject({ processed: 1, reconciled });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(completions()).toHaveLength(1);
    expect(completions()[0][1].p_outcome).toBe(outcome);
  });

  it.each(["timeout", "second page timeout", "repeated cursor", "http 503"])(
    "%s never completes a negative search or exposes private error detail", async (mode) => {
      const networkError = new TypeError("PRIVATE_PHONE PRIVATE_EMAIL PRIVATE_SOURCE PRIVATE_KEY");
      const pages = mode === "timeout" ? [networkError] : mode === "second page timeout"
        ? [page({ cards: [], cursor: "next" }), networkError] : mode === "repeated cursor"
          ? [page({ cards: [], cursor: "next" }), page({ cards: [], cursor: "next" })]
          : [page({ errors: [{ category: "API_ERROR", code: "SERVICE_UNAVAILABLE", detail: "PRIVATE_EMAIL" }] }, 503)];
      const fetcher = transport(...pages);
      expect((await reconcileBookingCardSaveOperations(1, operation)).reconciled).toBe(0);
      expect(fetcher).toHaveBeenCalledTimes(pages.length);
      expect(completions()).toHaveLength(1);
      expect(completions()[0][1].p_outcome).toBe("read_failed");
      expect(failures()).toHaveLength(1);
      expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain("PRIVATE_");
      if (mode === "http 503") expect(failures()[0][1]).toMatchObject({ p_http_status: 503,
        p_square_codes: ["SERVICE_UNAVAILABLE"], p_square_categories: ["API_ERROR"] });
    },
  );

  it.each(["throws", "merchant changed", "environment changed"])("config %s performs zero reads", async (mode) => {
    const fetcher = transport();
    if (mode === "throws") mocks.config.mockRejectedValue(new Error("PRIVATE_KEY"));
    else mocks.config.mockResolvedValue({ merchantId: mode === "merchant changed" ? "foreign" : "merchant_qa",
      environment: mode === "environment changed" ? "production" : "sandbox" });
    await reconcileBookingCardSaveOperations(1, operation);
    expect(fetcher).not.toHaveBeenCalled();
    expect(completions()[0][1].p_outcome).toBe("config_unavailable");
  });

  it("lost database completion is not relabelled as a failed Square read", async () => {
    const fetcher = transport(page({ cards: [receipt] }));
    const normal = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name, args) => {
      if (name === "complete_booking_card_save_reconciliation") throw new TypeError("PRIVATE_DB_LOSS");
      return normal(name, args);
    });
    expect((await reconcileBookingCardSaveOperations(1, operation)).reconciled).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(completions()).toHaveLength(1);
    expect(completions()[0][1].p_outcome).toBe("found");
    expect(failures()).toHaveLength(1);
    expect(failures()[0][1]).toMatchObject({ p_stage: "database_completion", p_code: "database_completion_uncertain" });
  });

  it("a stale completion cannot be counted as a recovered booking", async () => {
    transport(page({ cards: [receipt] }));
    mocks.rpc.mockResolvedValueOnce({ data: due, error: null })
      .mockResolvedValueOnce({ data: { ok: false, code: "claim_mismatch" }, error: null });
    expect(await reconcileBookingCardSaveOperations(1, operation)).toMatchObject({ reconciled: 0, unresolved: 1 });
    expect(failures()).toHaveLength(0);
  });

  it("an active lease wait performs no configuration or provider access", async () => {
    const fetcher = transport();
    mocks.rpc.mockResolvedValueOnce({ data: { ok: false, code: "reconciliation_wait" }, error: null });
    expect((await reconcileBookingCardSaveOperations(1, operation)).processed).toBe(0);
    expect(mocks.config).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(completions()).toHaveLength(0);
  });
});
