import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { disableCard, type SquareConfig } from "../client";
const cfg: SquareConfig = { salonId: "11111111-1111-4111-8111-111111111111", merchantId: "merchant_qa", locationId: "location_qa",
  accessToken: "synthetic-access", applicationId: "sandbox-app", environment: "sandbox", currency: "CAD",
  sync: { pullCreate: false, pullUpdate: false, pullCancel: false, pushCreate: false, pushUpdate: false, pushCancel: false } };
const cardId = "ccof:synthetic-card";
const disabled = { card: { id: cardId, enabled: false } };
const active = { card: { id: cardId, enabled: true } };
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
function transport(...values: Array<Response | Error>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(`https://connect.squareupsandbox.com/v2/cards/${encodeURIComponent(cardId)}${init.method === "POST" ? "/disable" : ""}`);
    calls.push(String(init.method));
    const value = values.shift();
    if (value instanceof Error) throw value;
    if (!value) throw new Error("Unexpected transport call");
    return value;
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());
describe("Square removal receipt truth and response loss", () => {
  it("accepts the exact disabled card receipt with one POST", async () => {
    const calls = transport(response(disabled)); await disableCard(cfg, cardId); expect(calls).toEqual(["POST"]);
  });
  it("recovers response loss through an exact read without repeating the mutation", async () => {
    const calls = transport(new Error("synthetic transport loss"), response(disabled));
    await disableCard(cfg, cardId); expect(calls).toEqual(["POST", "GET"]);
  });
  it.each([{}, { card: null }, { card: {} }, active, { card: { id: "other-card", enabled: false } }, { card: { id: cardId, enabled: "false" } }])(
    "does not claim removal from an invalid HTTP 200 receipt (%j)", async receipt => {
      const calls = transport(response(receipt), response(active));
      await expect(disableCard(cfg, cardId)).rejects.toThrow("removal_invalid_provider_receipt");
      expect(calls).toEqual(["POST", "GET"]);
    });
  it("may reconcile a malformed acknowledgment using an exact disabled read", async () => {
    const calls = transport(response({}), response(disabled));
    await disableCard(cfg, cardId); expect(calls).toEqual(["POST", "GET"]);
  });
  it.each([{ card: { id: "other-card", enabled: false } }, { card: { enabled: false } }, active, {}])(
    "rejects an unrelated or inconclusive fallback read (%j)", async receipt => {
      const calls = transport(new Error("synthetic lost response"), response(receipt));
      await expect(disableCard(cfg, cardId)).rejects.toThrow(); expect(calls).toEqual(["POST", "GET"]);
    });
  it("retains uncertainty when both transport and read fail", async () => {
    const calls = transport(new Error("synthetic lost response"), new Error("synthetic read timeout"));
    await expect(disableCard(cfg, cardId)).rejects.toThrow(); expect(calls).toEqual(["POST", "GET"]);
  });
  it("allows the provider-defined no-op when disabling an already-disabled card again", async () => {
    const calls = transport(response(disabled), response(disabled));
    await disableCard(cfg, cardId); await disableCard(cfg, cardId); expect(calls).toEqual(["POST", "POST"]);
  });
});

it.each([
 [new Error("source-token secret"), response(active), "removal_provider_write_failed", "not_removed"],
 [new Error("source-token secret"), new Error("timeout secret"), "removal_provider_write_failed", "read_failed"],
 [response({}), response({card:{id:"other",enabled:false}}), "removal_invalid_provider_receipt", "invalid_receipt"],
])("retains initial stage and separate fallback outcome",async(first,second,code,outcome)=>{
 const calls=transport(first as Response|Error,second as Response|Error);
 await expect(disableCard(cfg,cardId)).rejects.toMatchObject({failure:{code,reconciliationOutcome:outcome,retryability:"reconcile_first"}});expect(calls).toEqual(["POST","GET"]);
});
it("preserves allowlisted HTTP failure without raw provider details",async()=>{
 const calls=transport(new Response(JSON.stringify({errors:[{code:"FORBIDDEN",category:"AUTHENTICATION_ERROR",detail:"email secret"}]}),{status:403}),new Error("read failed"));
 let failure;try{await disableCard(cfg,cardId);}catch(error){failure=error;}
 expect(failure).toMatchObject({failure:{code:"removal_provider_write_failed",httpStatus:403,squareCodes:["FORBIDDEN"],reconciliationOutcome:"read_failed"}});
 expect(JSON.stringify(failure)).not.toContain("secret");expect(calls).toEqual(["POST","GET"]);
});

it.each(["not-json", "null", "[]"])("classifies an unreadable successful response as receipt validation: %s",async body=>{
 const calls=transport(new Response(body,{status:200}),response(active));
 await expect(disableCard(cfg,cardId)).rejects.toMatchObject({failure:{code:"removal_invalid_provider_receipt",stage:"receipt_validation",httpStatus:200,reconciliationOutcome:"not_removed"}});
 expect(calls).toEqual(["POST","GET"]);
});
