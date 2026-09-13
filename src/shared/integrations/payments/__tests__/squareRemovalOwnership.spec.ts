import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { SquareProvider } from "../square";
import type { SquareConfig } from "@/shared/integrations/square/client";

const cfg: SquareConfig = { salonId: "11111111-1111-4111-8111-111111111111", merchantId: "merchant_qa", locationId: "location_qa",
  accessToken: "synthetic-secret", applicationId: "sandbox-app", environment: "sandbox", currency: "CAD",
  sync: { pullCreate: false, pullUpdate: false, pullCancel: false, pushCreate: false, pushUpdate: false, pushCancel: false } };
const input = { cardId: "ccof:synthetic", customerId: "customer_qa" };
const card = { id: input.cardId, customer_id: input.customerId, merchant_id: cfg.merchantId,
  enabled: true, card_brand: "VISA", last_4: "1111" };
const provider = new SquareProvider(cfg);
function transport(read: unknown = card) {
  const methods: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const method = String(init.method); methods.push(method);
    expect(url).toBe(`https://connect.squareupsandbox.com/v2/cards/ccof%3Asynthetic${method === "POST" ? "/disable" : ""}`);
    if (method === "GET" && read instanceof Error) throw read;
    return new Response(JSON.stringify({ card: method === "GET" ? read : { ...card, enabled: false } }), { status: 200 });
  }));
  return methods;
}
afterEach(() => vi.unstubAllGlobals());

describe("Square removal checks provider ownership before mutation", () => {
  it("reads an active bound card before disabling it", async () => {
    const methods = transport();
    expect(await provider.removeSavedCard(input)).toEqual({ providerReference: input.cardId });
    expect(methods).toEqual(["GET", "POST"]);
  });
  it("an already disabled bound card succeeds with one read and no disable", async () => {
    const methods = transport({ ...card, enabled: false });
    expect(await provider.removeSavedCard(input)).toEqual({ providerReference: input.cardId });
    expect(methods).toEqual(["GET"]);
  });
  it.each([
    { customer_id: "another_customer" }, { merchant_id: "another_merchant" }, { id: "ccof:other" },
    { customer_id: null }, { merchant_id: null }, { enabled: null }, { enabled: "false" },
    { card_brand: null }, { last_4: null }, { last_4: "12345" },
  ])("rejects a mismatched or incomplete read without disabling: %j", async change => {
    const methods = transport({ ...card, ...change });
    await expect(provider.removeSavedCard(input)).rejects.toMatchObject({failure:{code:"removal_preflight_invalid",mutationStatus:"not_requested"}});
    expect(methods).toEqual(["GET"]);
  });
  it("a disabled card belonging to another customer is not a success receipt", async () => {
    const methods = transport({ ...card, enabled: false, customer_id: "another_customer" });
    await expect(provider.removeSavedCard(input)).rejects.toMatchObject({failure:{code:"removal_preflight_invalid",mutationStatus:"not_requested"}});
    expect(methods).toEqual(["GET"]);
  });
  it("read timeout performs no provider mutation", async () => {
    const methods = transport(new Error("synthetic timeout"));
    await expect(provider.removeSavedCard(input)).rejects.toMatchObject({failure:{code:"removal_preflight_failed",mutationStatus:"not_requested"}});
    expect(methods).toEqual(["GET"]);
  });
  it("missing customer binding performs no provider request", async () => {
    const methods = transport();
    await expect(provider.removeSavedCard({ ...input, customerId: "" })).rejects.toThrow();
    expect(methods).toEqual([]);
  });
  it("a sequential retry reads the disabled card and never disables again", async () => {
    const methods: string[] = []; let disabled = false;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      methods.push(String(init.method)); if (init.method === "POST") disabled = true;
      return new Response(JSON.stringify({ card: { ...card, enabled: !disabled } }), { status: 200 });
    }));
    expect(await provider.removeSavedCard(input)).toEqual({ providerReference: input.cardId });
    expect(await provider.removeSavedCard(input)).toEqual({ providerReference: input.cardId });
    expect(methods).toEqual(["GET", "POST", "GET"]);
  });
});
