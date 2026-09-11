import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// Adapter tests isolate the durable identity coordinator, which has its own
// RPC/race coverage. Keep the real Square customer transport/receipt parser.
vi.mock("../cardCustomerClaim", async () => {
  const { ensureSquareCustomer } = await import("../client");
  return { resolveSquareCardCustomer: (config: SquareConfig) => ensureSquareCustomer(config,{
    phone:"+16045550123",name:"Synthetic Guest",referenceId:"booking:qa",idempotencyKey:"sqcust:booking_qa",reconcileReference:true,
  }) };
});
import { SquareProvider } from "../../payments/square";
import { CardDeliveryError } from "../../payments/cardDeliveryFailure";
import { ensureSquareCustomer, findSquareCustomerByPhone, listCardsByReferenceId, saveCardOnFile, type SquareConfig } from "../client";
const operation = "55630000-0000-4000-8000-000000000050";
const customerOperation = { operationId:operation,attemptToken:"55630000-0000-4000-8000-000000000051" };
const reference = `nq-card:${operation}`;
const cfg: SquareConfig = { salonId: "55630000-0000-4000-8000-000000000001", merchantId: "merchant_qa", locationId: "location_qa",
  accessToken: "PRIVATE_ACCESS_TOKEN", applicationId: "sandbox-app", environment: "sandbox", currency: "CAD",
  sync: { pullCreate:false,pullUpdate:false,pullCancel:false,pushCreate:false,pushUpdate:false,pushCancel:false } };
const receipt = { id:"card_qa",customer_id:"customer_qa",merchant_id:"merchant_qa",reference_id:reference,enabled:true,card_brand:"VISA",last_4:"4242" };
const input = { customerId:"customer_qa",sourceId:"PRIVATE_SOURCE",idempotencyKey:`${operation}:card`,referenceId:reference };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function fetchMock(...responses: Array<Response | Error>) {
  const mock = vi.fn(async (url: string) => {
    expect(url.startsWith("https://connect.squareupsandbox.com/v2/")).toBe(true);
    const result = responses.shift();
    if (result instanceof Error) throw result;
    if (!result) throw new Error("unexpected provider call");
    return result;
  });
  vi.stubGlobal("fetch",mock); return mock;
}
afterEach(() => vi.unstubAllGlobals());
describe("Square card delivery and safe receipt truth", () => {
  it("saves once with customer, operation reference and acknowledged durable binding", async () => {
    const fetcher = fetchMock(response({}), response({}), response({ customer:{id:"customer_qa"} }), response({ card:receipt }));
    const beforeCardDispatch = vi.fn(async () => { expect(fetcher).toHaveBeenCalledTimes(3); });
    const result = await new SquareProvider(cfg).saveCardOnFile({ customer:{phone:"+16045550123",name:"Synthetic Guest",referenceId:"booking:qa"},
      sourceToken:input.sourceId,idempotencyKey:operation,cardReferenceId:reference,customerIdempotencyKey:"sqcust:booking_qa",customerOperation,beforeCardDispatch });
    expect(result).toEqual({customerId:"customer_qa",cardId:"card_qa",brand:"VISA",last4:"4242"});
    expect(beforeCardDispatch).toHaveBeenCalledWith({customerId:"customer_qa",merchantId:"merchant_qa",environment:"sandbox"});
    expect(fetcher).toHaveBeenCalledTimes(4);
    const calls=fetcher.mock.calls as unknown as [string,RequestInit][];
    expect(JSON.parse(String(calls[2][1].body)).idempotency_key).toBe("sqcust:booking_qa");
    expect(JSON.parse(String(calls[3][1].body)).card.reference_id).toBe(reference);
  });
  it("reuses the reference-matched customer after an earlier customer response was lost", async () => {
    const fetcher=fetchMock(response({customers:[]}),response({customers:[{id:"customer_qa",reference_id:"booking:qa"}]}),response({card:receipt}));
    await new SquareProvider(cfg).saveCardOnFile({customer:{phone:"+16045550123",referenceId:"booking:qa"},sourceToken:input.sourceId,
      idempotencyKey:operation,cardReferenceId:reference,customerIdempotencyKey:"sqcust:booking_qa",customerOperation});
    const calls=fetcher.mock.calls as unknown as [string,RequestInit][];
    expect(calls.some(([url])=>url.endsWith("/customers"))).toBe(false);
    expect(JSON.parse(String(calls[1][1].body)).query.filter.reference_id.exact).toBe("booking:qa");
  });
  it("preserves a received HTTP status even if the provider body is unreadable",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response("<invalid>",{status:502})));
    await expect(saveCardOnFile(cfg,input)).rejects.toMatchObject({failure:{stage:"card_create",code:"provider_response_lost",httpStatus:502}});
  });
  it("preserves HTTP 200 when a customer search receipt is malformed",async()=>{
    fetchMock(response({customers:[{}]}));
    await expect(findSquareCustomerByPhone(cfg,"+16045550123")).rejects.toMatchObject({failure:{stage:"customer_search",httpStatus:200}});
  });
  it("reports the malformed fallback create receipt instead of the earlier phone rejection",async()=>{
    fetchMock(response({errors:[{code:"INVALID_PHONE_NUMBER",category:"INVALID_REQUEST_ERROR"}]},400),response({customer:{}}));
    await expect(ensureSquareCustomer(cfg,{referenceId:"booking:qa",idempotencyKey:operation})).rejects.toMatchObject({
      failure:{stage:"customer_create",code:"square_customer_create_failed",httpStatus:200,retryability:"reconcile_first"},
    });
  });
  it("does not dispatch CreateCard if database binding acknowledgment is lost", async () => {
    const fetcher=fetchMock(response({customers:[{id:"customer_qa"}]}));
    await expect(new SquareProvider(cfg).saveCardOnFile({customer:{phone:"+16045550123",referenceId:"booking:qa"},sourceToken:input.sourceId,
      idempotencyKey:operation,cardReferenceId:reference,customerOperation,beforeCardDispatch:async()=>{throw new Error("binding failed");}})).rejects.toThrow("binding failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("records a definitive decline as a new-card retry, without provider details", async () => {
    fetchMock(response({errors:[{code:"CARD_DECLINED",category:"PAYMENT_METHOD_ERROR",detail:"PRIVATE_SOURCE PRIVATE_PHONE PRIVATE_EMAIL"}]},400));
    const failure=await saveCardOnFile(cfg,input).catch((error:unknown)=>error);
    expect(failure).toBeInstanceOf(CardDeliveryError);
    expect((failure as CardDeliveryError).failure).toMatchObject({stage:"card_create",code:"square_card_create_failed",httpStatus:400,retryability:"new_card",squareCodes:["CARD_DECLINED"]});
    expect(JSON.stringify(failure)).not.toMatch(/PRIVATE_/);
  });
  it("never declares an unknown/mixed Square error to be a definitive decline", async () => {
    fetchMock(response({errors:[{code:"CARD_DECLINED",category:"PAYMENT_METHOD_ERROR"},{code:"PRIVATE_SOURCE",category:"PRIVATE_EMAIL"}]},400));
    const failure=await saveCardOnFile(cfg,input).catch((error:unknown)=>error);
    expect((failure as CardDeliveryError).failure.retryability).toBe("reconcile_first");
    expect(JSON.stringify(failure)).not.toMatch(/PRIVATE_/);
  });
  it("treats response loss after dispatch as unknown and never automatically resends", async () => {
    const fetcher=fetchMock(new TypeError("socket reset PRIVATE_SOURCE PRIVATE_ACCESS_TOKEN"));
    const failure=await saveCardOnFile(cfg,input).catch((error:unknown)=>error);
    expect((failure as CardDeliveryError).failure).toMatchObject({stage:"card_create",code:"provider_response_lost",retryability:"reconcile_first"});
    expect(fetcher).toHaveBeenCalledTimes(1); expect(JSON.stringify(failure)).not.toMatch(/PRIVATE_/);
  });
  it.each([
    {customer_id:"another_customer"},{merchant_id:"another_merchant"},{reference_id:"another_operation"},
    {enabled:false},{enabled:undefined},{id:{value:"card_qa"}},{last_4:4242},{last_4:""},{card_brand:"UNKNOWN"},
  ])("rejects incomplete or incorrectly bound card receipt: %j", async (patch) => {
    fetchMock(response({card:{...receipt,...patch}}));
    await expect(saveCardOnFile(cfg,input)).rejects.toMatchObject({failure:{stage:"receipt_validation",code:"square_invalid_card_receipt",retryability:"reconcile_first"}});
  });
  it("reads every page before concluding that one matching card exists", async () => {
    const fetcher=fetchMock(response({cards:[receipt],cursor:"page2"}),response({cards:[{...receipt,id:"second_card"}]}));
    const cards=await listCardsByReferenceId(cfg,reference);
    expect(cards).toHaveLength(2); expect(fetcher.mock.calls[1][0]).toContain("cursor=page2");
    expect(fetcher.mock.calls.every(([url])=>url.includes("/cards?reference_id="))).toBe(true);
  });
  it("does not report absence after a timeout on the next page", async () => {
    fetchMock(response({cards:[],cursor:"page2"}),new Error("PRIVATE_ACCESS_TOKEN"));
    await expect(listCardsByReferenceId(cfg,reference)).rejects.toMatchObject({failure:{code:"reconciliation_read_failed"}});
  });
  it.each([{cards:{}},{cards:[{...receipt,last_4:null}]},{cards:[{...receipt,reference_id:"wrong"}]},{cards:[],cursor:42}])(
    "never turns a malformed provider read into not found: %j",async (body)=>{
      fetchMock(response(body));
      await expect(listCardsByReferenceId(cfg,reference)).rejects.toMatchObject({failure:{code:"reconciliation_invalid_card"}});
    });
  it("rejects a repeated cursor instead of treating a partial search as complete",async()=>{
    fetchMock(response({cards:[],cursor:"same"}),response({cards:[],cursor:"same"}));
    await expect(listCardsByReferenceId(cfg,reference)).rejects.toMatchObject({failure:{code:"reconciliation_read_incomplete"}});
  });
  it("preserves disabled matches for explicit receipt validation, not an empty result",async()=>{
    fetchMock(response({cards:[{...receipt,enabled:false}]}));
    expect(await listCardsByReferenceId(cfg,reference)).toMatchObject([{enabled:false}]);
  });
});
