import { describe, expect, it, vi } from "vitest";
import { readCardSandboxConfig } from "../../../../scripts/qa-square-card-sandbox-guard";
import { createRemovalSandboxGuard, REMOVAL_QA_ORIGIN } from "../../../../scripts/qa-square-removal-sandbox-guard";
const cfg = readCardSandboxConfig({ NAILIQ_CARD_SANDBOX_QA: "1", NAILIQ_QA_SQUARE_ENVIRONMENT: "sandbox",
  NAILIQ_QA_SQUARE_NOTIFICATIONS_OFF_VERIFIED: "1", DISABLE_OUTBOUND_SMS: "1", DISABLE_OUTBOUND_EMAIL: "1", DISABLE_OUTBOUND_CALLS: "1",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55631", DB_URL: "postgresql://postgres:postgres@127.0.0.1:55632/postgres",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-local-service-key", NAILIQ_QA_SQUARE_SANDBOX_APPLICATION_ID: "sandbox-sq0idb-syntheticapp",
  NAILIQ_QA_SQUARE_SANDBOX_MERCHANT_ID: "syntheticmerchant", NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID: "syntheticlocation", NAILIQ_QA_SQUARE_SANDBOX_ACCESS_TOKEN: "synthetic-sandbox-token-long" });
const origin = "https://connect.squareupsandbox.com";
const headers = { Authorization: `Bearer ${cfg.square.accessToken}`, "Content-Type": "application/json" };
const reference = "nq-card:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function setup() {
  const native = vi.fn(async (input: RequestInfo | URL) => {
    const req = new Request(input); const path = new URL(req.url).pathname;
    const body = path === "/oauth2/token/status" ? { client_id: cfg.square.applicationId, merchant_id: cfg.square.merchantId }
      : path === "/v2/locations" ? { locations: [{ id: cfg.square.locationId, merchant_id: cfg.square.merchantId, currency: "CAD", status: "ACTIVE" }] }
        : path.includes("/cards") ? { card: { id: "ccof:synthetic", customer_id: "syntheticcustomer", merchant_id: cfg.square.merchantId, reference_id: reference, enabled: !path.endsWith("/disable") } } : {};
    return Response.json(body);
  });
  const guard = createRemovalSandboxGuard(cfg, native);
  const create = () => guard.fetch(origin + "/v2/cards", { method: "POST", headers, body: JSON.stringify({ idempotency_key: "synthetic-key", source_id: "cnon:card-nonce-ok", card: { customer_id: "syntheticcustomer", reference_id: reference } }) });
  const disable = () => guard.fetch(origin + "/v2/cards/ccof%3Asynthetic/disable", { method: "POST", headers, body: "{}" });
  const read = () => guard.fetch(origin + "/v2/cards/ccof%3Asynthetic", { headers });
  return { guard, native, create, disable, read };
}
describe("Actual removal Sandbox transport boundaries", () => {
  it("requires provider preflight before QA or card calls", async () => {
    const s = setup(); await expect(s.create()).rejects.toThrow("sandbox_preflight_required");
    await expect(s.guard.fetch(REMOVAL_QA_ORIGIN + "/rest/v1/bookings")).rejects.toThrow("sandbox_preflight_required"); expect(s.native).not.toHaveBeenCalled();
  });
  it.each(["https://connect.squareup.com/v2/cards", "https://fshmobzyjhmtvndobwsy.supabase.co/rest/v1/bookings", "http://127.0.0.1:55631/rest/v1/bookings", REMOVAL_QA_ORIGIN + "/functions/v1/send", origin + "/v2/payments", origin + "/v2/refunds"])("blocks unrelated origin or endpoint %s", async url => {
    const s = setup(); await s.guard.preflight(); const count = s.native.mock.calls.length;
    await expect(s.guard.fetch(url)).rejects.toThrow(); expect(s.native).toHaveBeenCalledTimes(count);
  });
  it("cannot read/disable a card not created during this run", async () => {
    const s = setup(); await s.guard.preflight(); const count = s.native.mock.calls.length;
    await expect(s.disable()).rejects.toThrow("sandbox_card_not_owned_by_run"); await expect(s.read()).rejects.toThrow("sandbox_card_not_owned_by_run"); expect(s.native).toHaveBeenCalledTimes(count);
  });
  it("permits one disable and exact reads, blocks duplicate disable", async () => {
    const s = setup(); await s.guard.preflight(); await s.create(); await s.read(); await s.disable(); await s.read();
    await expect(s.disable()).rejects.toThrow("sandbox_duplicate_disable_denied");
    expect(s.guard.counts()).toMatchObject({ cardCreates: 1, disableCalls: 1, removalReads: 2, deniedDuplicateDisables: 1 });
  });
  it("loses a real disable response, blocks fallback, then permits read-only recovery", async () => {
    const s = setup(); await s.guard.preflight(); await s.create(); s.guard.setMode("response_loss");
    await expect(s.disable()).rejects.toThrow("qa_disable_response_loss"); await expect(s.read()).rejects.toThrow("qa_fallback_read_timeout");
    s.guard.setMode("success"); await s.read(); expect(s.guard.counts()).toMatchObject({ disableCalls: 1, removalReads: 1 });
  });
  it.each(["db_before", "db_after"] as const)("injects %s without provider work", async mode => {
    const s = setup(); await s.guard.preflight(); s.guard.setMode(mode); const count = s.native.mock.calls.length;
    await expect(s.guard.fetch(REMOVAL_QA_ORIGIN + "/rest/v1/rpc/complete_booking_card_management_operation", { method: "POST", body: "{}" })).rejects.toThrow("qa_database_response_loss");
    expect(s.native).toHaveBeenCalledTimes(count + (mode === "db_after" ? 1 : 0)); expect(s.guard.counts().disableCalls).toBe(0);
  });
});
