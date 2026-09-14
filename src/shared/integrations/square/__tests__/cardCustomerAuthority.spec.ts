import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ensureSquareCustomer, verifySquareCardCustomerIdentity, type SquareConfig } from "../client";

const cfg: SquareConfig = {
  salonId: "a1000000-0000-4000-8000-000000000001", merchantId: "synthetic-merchant",
  locationId: "synthetic-location", applicationId: "synthetic-app",
  accessToken: "PRIVATE_SYNTHETIC_ACCESS", environment: "sandbox", currency: "CAD",
  sync: { pullCreate: false, pullUpdate: false, pullCancel: false,
    pushCreate: false, pushUpdate: false, pushCancel: false },
};
const referenceId = "nq-customer:a1000000-0000-4000-8000-000000000002";
const idempotencyKey = "sqcu:a1000000-0000-4000-8000-000000000002";
type AuthorityOptions = {
  name: string; phone: string | null; email: string | null; referenceId: string;
  idempotencyKey: string; lookupPolicy: "verified_phone" | "reference_only";
  previouslyDispatched: boolean; beforeCreate?: () => Promise<void>;
};
function options(overrides: Partial<AuthorityOptions> = {}): AuthorityOptions {
  return { name: "Synthetic Card Guest", phone: "+16045550881", email: "synthetic@example.test",
    referenceId, idempotencyKey, lookupPolicy: "reference_only", previouslyDispatched: false, ...overrides };
}
type Call = { path: string; body: Record<string, unknown> };
let calls: Call[];
function transport(reply: (call: Call) => unknown | Promise<unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.hostname).toBe("connect.squareupsandbox.com");
    expect(init?.method).toBe("POST");
    expect(["/v2/customers/search", "/v2/customers"]).toContain(url.pathname);
    const call = { path: url.pathname, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    const value = await reply(call);
    return value instanceof Response ? value : new Response(JSON.stringify(value), { status: 200 });
  }));
}
const filterOf = (call: Call) => (call.body.query as { filter?: Record<string, unknown> } | undefined)?.filter;
const searches = () => calls.filter(call => call.path === "/v2/customers/search");
const creates = () => calls.filter(call => call.path === "/v2/customers");
const created = () => ({ customer: { id: "synthetic-created", reference_id: referenceId, phone_number: "+16045550881" } });
beforeEach(() => { calls = []; });
afterEach(() => vi.unstubAllGlobals());

describe("Square card customer authority transport", () => {
  it("unverified booking only searches its reference and creates without declared phone or email", async () => {
    transport(call => call.path.endsWith("/search") ? {} : created());
    expect(await ensureSquareCustomer(cfg, options())).toBe("synthetic-created");
    expect(searches().map(filterOf)).toEqual([{ reference_id: { exact: referenceId } }]);
    expect(creates()).toHaveLength(1);
    expect(creates()[0].body).toEqual({ given_name: "Synthetic", family_name: "Card Guest",
      reference_id: referenceId, idempotency_key: idempotencyKey });
  });

  it.each(["verified_phone", "reference_only"] as const)("%s resolves its reference before any unrelated contact hit", async lookupPolicy => {
    transport(call => filterOf(call)?.reference_id
      ? { customers: [{ id: "synthetic-owned", reference_id: referenceId }] }
      : { customers: [{ id: "synthetic-wrong", phone_number: "+16045550881", email_address: "synthetic@example.test" }] });
    expect(await ensureSquareCustomer(cfg, options({ lookupPolicy }))).toBe("synthetic-owned");
    expect(searches().map(filterOf)).toEqual([{ reference_id: { exact: referenceId } }]);
    expect(creates()).toHaveLength(0);
  });

  it("SMS-authorized discovery uses exact canonical phone only after an empty reference read", async () => {
    transport(call => filterOf(call)?.phone_number
      ? { customers: [{ id: "synthetic-phone-owner", phone_number: "+16045550881" }] } : {});
    expect(await ensureSquareCustomer(cfg, options({ lookupPolicy: "verified_phone", phone: "6045550881" }))).toBe("synthetic-phone-owner");
    expect(searches().map(filterOf)).toEqual([
      { reference_id: { exact: referenceId } }, { phone_number: { exact: "+16045550881" } },
    ]);
    expect(creates()).toHaveLength(0);
  });

  it("fresh SMS-authorized create retains phone but does not treat a declared email as verified", async () => {
    transport(call => call.path.endsWith("/search") ? {} : created());
    expect(await ensureSquareCustomer(cfg, options({ lookupPolicy: "verified_phone" }))).toBe("synthetic-created");
    expect(searches().some(call => filterOf(call)?.email_address)).toBe(false);
    expect(creates()[0].body.phone_number).toBe("+16045550881");
    expect(creates()[0].body).not.toHaveProperty("email_address");
  });

  it.each(["verified_phone", "reference_only"] as const)("previously dispatched %s never discovers contact and preserves frozen request body/key", async lookupPolicy => {
    transport(call => call.path.endsWith("/search") ? {} : created());
    expect(await ensureSquareCustomer(cfg, options({ lookupPolicy, previouslyDispatched: true }))).toBe("synthetic-created");
    expect(searches().map(filterOf)).toEqual([{ reference_id: { exact: referenceId } }]);
    expect(creates()).toHaveLength(1);
    expect(creates()[0].body).toEqual({ given_name: "Synthetic", family_name: "Card Guest",
      phone_number: "+16045550881", email_address: "synthetic@example.test",
      reference_id: referenceId, idempotency_key: idempotencyKey });
  });

  it.each(["", "not-a-phone", "+123"])("invalid SMS subject %s cannot create or fall back to email", async phone => {
    transport(() => ({}));
    await expect(ensureSquareCustomer(cfg, options({ lookupPolicy: "verified_phone", phone }))).rejects.toThrow();
    expect(creates()).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(searches().some(call => filterOf(call)?.email_address)).toBe(false);
  });

  it.each([
    { referenceId: "" }, { referenceId: "nq-customer:not-a-uuid" },
    { idempotencyKey: "" }, { idempotencyKey: "a".repeat(46) },
  ])("invalid explicit binding cannot perform provider work: %j", async invalid => {
    transport(() => ({}));
    await expect(ensureSquareCustomer(cfg, options(invalid))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it.each([null, "false", 1])("malformed dispatch-state %s is never treated as authority to preserve contact", async value => {
    transport(call => call.path.endsWith("/search") ? {} : created());
    await expect(ensureSquareCustomer(cfg, options({ previouslyDispatched: value as unknown as boolean }))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("fresh unverified booking with no name gets a generic provider name and no contact", async () => {
    transport(call => call.path.endsWith("/search") ? {} : created());
    await ensureSquareCustomer(cfg, options({ name: "  ", phone: null, email: null }));
    expect([creates()[0].body.given_name, creates()[0].body.family_name].filter(Boolean).join(" ")).toBe("NailIQ Guest");
    expect(creates()[0].body).not.toHaveProperty("phone_number");
    expect(creates()[0].body).not.toHaveProperty("email_address");
  });

  it.each([
    { customers: [{ id: "different-phone", phone_number: "+16045550999" }] },
    { customers: [{ id: "missing-phone" }] },
    { customers: [{ id: "malformed-phone", phone_number: { unsafe: true } }] },
    { customers: [{ id: "one", phone_number: "+16045550881" }, { id: "two", phone_number: "+16045550881" }] },
    { customers: [{ id: "invalid id", phone_number: "+16045550881" }] },
  ])("rejects a mismatched/malformed/ambiguous phone receipt without creating: %j", async phoneReceipt => {
    transport(call => filterOf(call)?.phone_number ? phoneReceipt : {});
    await expect(ensureSquareCustomer(cfg, options({ lookupPolicy: "verified_phone" }))).rejects.toMatchObject({ failure: { stage: "customer_search" } });
    expect(creates()).toHaveLength(0);
  });

  it.each([
    { customers: [{ id: "one", reference_id: referenceId }, { id: "two", reference_id: referenceId }] },
    { customers: [{ id: "wrong-reference", reference_id: "other" }] },
    { customers: [{ id: "missing-reference" }] },
    { customers: [{ id: "invalid id", reference_id: referenceId }] },
    { customers: null }, { customers: [], cursor: "unread-next-page" },
  ])("invalid reference search never falls through to contact or creation: %j", async value => {
    transport(() => value);
    await expect(ensureSquareCustomer(cfg, options({ lookupPolicy: "verified_phone" }))).rejects.toMatchObject({ failure: { stage: "customer_search" } });
    expect(calls).toHaveLength(1);
    expect(creates()).toHaveLength(0);
  });

  it.each([
    new Response(JSON.stringify({ errors: [{ category: "API_ERROR", code: "SERVICE_UNAVAILABLE", detail: "PRIVATE_CONTACT@example.test" }] }), { status: 503 }),
    new Response(JSON.stringify({ errors: [{ category: "API_ERROR", code: "INTERNAL_SERVER_ERROR", detail: "PRIVATE_CONTACT@example.test" }] }), { status: 200 }),
  ])("provider read failure preserves safe diagnostics and never becomes absence", async response => {
    transport(() => response);
    let failure: unknown;
    try { await ensureSquareCustomer(cfg, options({ lookupPolicy: "verified_phone" })); } catch (e) { failure = e; }
    expect(failure).toMatchObject({ failure: { stage: "customer_search", squareCategories: expect.any(Array) } });
    expect(String(failure) + JSON.stringify(failure)).not.toMatch(/PRIVATE_CONTACT|PRIVATE_SYNTHETIC_ACCESS|Authorization|synthetic@example/);
    expect(calls).toHaveLength(1);
    expect(creates()).toHaveLength(0);
  });

  it.each([
    { customer: { id: "missing-reference" } },
    { customer: { id: "wrong-reference", reference_id: "other" } },
    { customer: { id: "invalid id", reference_id: referenceId } },
    { customer: { id: 123, reference_id: referenceId } },
    { customer: null }, {},
  ])("invalid CreateCustomer receipt stays uncertain, never retries under another key: %j", async value => {
    transport(call => call.path.endsWith("/search") ? {} : value);
    await expect(ensureSquareCustomer(cfg, options())).rejects.toMatchObject({ failure: { stage: "customer_create", retryability: "reconcile_first" } });
    expect(creates()).toHaveLength(1);
    expect(creates()[0].body.idempotency_key).toBe(idempotencyKey);
  });

  it("CreateCustomer response loss does not replay or expose private transport details", async () => {
    transport(call => { if (call.path.endsWith("/search")) return {}; throw new TypeError("PRIVATE_RESPONSE_LOSS synthetic@example.test"); });
    let failure: unknown;
    try { await ensureSquareCustomer(cfg, options()); } catch (e) { failure = e; }
    expect(failure).toMatchObject({ failure: { stage: "customer_create", retryability: "reconcile_first" } });
    expect(String(failure) + JSON.stringify(failure)).not.toMatch(/PRIVATE_RESPONSE_LOSS|synthetic@example/);
    expect(creates()).toHaveLength(1);
  });

  it("failed dispatch preparation performs no CreateCustomer", async () => {
    transport(() => ({}));
    await expect(ensureSquareCustomer(cfg, options({ beforeCreate: async () => { throw new Error("prepare_not_acknowledged"); } }))).rejects.toThrow("prepare_not_acknowledged");
    expect(creates()).toHaveLength(0);
  });

  it("repeated exact reference recovery returns the same customer with zero duplicate creates", async () => {
    transport(() => ({ customers: [{ id: "synthetic-owned", reference_id: referenceId }] }));
    expect(await ensureSquareCustomer(cfg, options({ previouslyDispatched: true }))).toBe("synthetic-owned");
    expect(await ensureSquareCustomer(cfg, options({ previouslyDispatched: true }))).toBe("synthetic-owned");
    expect(creates()).toHaveLength(0);
    expect(searches().map(filterOf)).toEqual(Array(2).fill({ reference_id: { exact: referenceId } }));
  });
});

describe("legacy Square customer binding validation is read-only", () => {
  const customerId = "synthetic-legacy";
  function readTransport(value: unknown, status = 200) {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("connect.squareupsandbox.com");
      expect(url.pathname).toBe(`/v2/customers/${customerId}`);
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (value instanceof Error) throw value;
      return new Response(JSON.stringify(value), { status });
    }));
  }
  it.each([
    { referenceId }, { verifiedPhone: "6045550881" },
  ])("returns only true for an exact ID plus matching authority: %j", async binding => {
    readTransport({ customer: { id: customerId, reference_id: referenceId,
      phone_number: "+16045550881", email_address: "PRIVATE_CONTACT@example.test", given_name: "PRIVATE_NAME" } });
    expect(await verifySquareCardCustomerIdentity(cfg, { customerId, ...binding })).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { reference_id: "unrelated" }, {}, { phone_number: "+16045550999" },
  ])("missing or different identity returns false without discovering another customer: %j", async receipt => {
    readTransport({ customer: { id: customerId, ...receipt } });
    const binding = "phone_number" in receipt ? { verifiedPhone: "+16045550881" } : { referenceId };
    expect(await verifySquareCardCustomerIdentity(cfg, { customerId, ...binding })).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    {}, { customer: null }, { customer: [] },
    { customer: { id: "wrong-id", reference_id: referenceId } },
    { customer: { id: customerId, reference_id: { invalid: true } } },
  ])("malformed customer receipt remains uncertain: %j", async receipt => {
    readTransport(receipt);
    await expect(verifySquareCardCustomerIdentity(cfg, { customerId, referenceId })).rejects.toMatchObject({ failure: { stage: "customer_search" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([123, "not-a-phone"])("malformed returned phone %s cannot become a negative proof or trigger another lookup", async phone => {
    readTransport({ customer: { id: customerId, phone_number: phone } });
    await expect(verifySquareCardCustomerIdentity(cfg, { customerId, verifiedPhone: "+16045550881" })).rejects.toMatchObject({ failure: { stage: "customer_search" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["NOT_FOUND", "CUSTOMER_NOT_FOUND"])("only a definitive 404 %s becomes false", async code => {
    readTransport({ errors: [{ code, category: "INVALID_REQUEST_ERROR" }] }, 404);
    expect(await verifySquareCardCustomerIdentity(cfg, { customerId, referenceId })).toBe(false);
  });
  it.each([
    { errors: [{ code: "NOT_FOUND" }, { code: "UNAUTHORIZED" }] },
    { errors: [{ detail: "PRIVATE_NO_CODE" }] }, {},
  ])("ambiguous 404 preserves unknown and hides provider detail: %j", async body => {
    readTransport(body, 404);
    let failure: unknown;
    try { await verifySquareCardCustomerIdentity(cfg, { customerId, referenceId }); } catch (e) { failure = e; }
    expect(failure).toMatchObject({ failure: { stage: "customer_search", httpStatus: 404 } });
    expect(String(failure) + JSON.stringify(failure)).not.toContain("PRIVATE_NO_CODE");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("transport failure never returns false or retains its private cause", async () => {
    readTransport(new TypeError("PRIVATE_TRANSPORT synthetic@example.test"));
    let failure: unknown;
    try { await verifySquareCardCustomerIdentity(cfg, { customerId, referenceId }); } catch (e) { failure = e; }
    expect(failure).toMatchObject({ failure: { stage: "customer_search" } });
    expect(String(failure) + JSON.stringify(failure)).not.toMatch(/PRIVATE_TRANSPORT|synthetic@example|PRIVATE_SYNTHETIC_ACCESS/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, ""])("missing reference authority %s cannot accidentally match an omitted provider reference", async missing => {
    readTransport({ customer: { id: customerId } });
    await expect(verifySquareCardCustomerIdentity(cfg, { customerId, referenceId: missing as unknown as string })).rejects.toMatchObject({ failure: { stage: "customer_search" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
