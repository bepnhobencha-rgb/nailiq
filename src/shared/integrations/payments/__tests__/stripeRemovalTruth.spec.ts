import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
vi.mock("server-only", () => ({}));
import { StripeProvider } from "../stripe";

const cardId = "pm_synthetic_card";
const customerId = "cus_synthetic_owner";
const input = { cardId, customerId };
const pm = (customer: unknown) => ({ id: cardId, object: "payment_method", type: "card", customer });
const retrieve = vi.fn();
const detach = vi.fn();
const provider = new StripeProvider({ paymentMethods: { retrieve, detach } } as unknown as Stripe);
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in unit test"); }));
  retrieve.mockResolvedValue(pm(customerId));
  detach.mockResolvedValue(pm(null));
});
afterEach(() => vi.unstubAllGlobals());

describe("Stripe removal requires matching receipt and customer binding", () => {
  it("detaches the matching customer's card with a confirmed null binding", async () => {
    expect(await provider.removeSavedCard(input)).toEqual({ providerReference: cardId });
    expect(detach).toHaveBeenCalledExactlyOnceWith(cardId);
    expect(retrieve).toHaveBeenCalledExactlyOnceWith(cardId);
  });
  it("accepts an expanded matching customer before detach", async () => {
    retrieve.mockResolvedValue(pm({ id: customerId, object: "customer" }));
    expect(await provider.removeSavedCard(input)).toEqual({ providerReference: cardId });
    expect(detach).toHaveBeenCalledTimes(1);
  });
  it("already detached exact card is read-only", async () => {
    retrieve.mockResolvedValue(pm(null));
    expect(await provider.removeSavedCard(input)).toEqual({ providerReference: cardId });
    expect(detach).not.toHaveBeenCalled();
  });
  it.each([
    ["missing customer", { id: cardId, object: "payment_method", type: "card" }],
    ["wrong card", { ...pm(null), id: "pm_other" }],
    ["wrong object", { ...pm(null), object: "customer" }],
    ["wrong type", { ...pm(null), type: "us_bank_account" }],
    ["empty envelope", {}],
    ["array", []],
  ])("does not detach or accept malformed initial read: %s", async (_label, value) => {
    retrieve.mockResolvedValue(value);
    await expect(provider.removeSavedCard(input)).rejects.toThrow();
    expect(detach).not.toHaveBeenCalled();
  });
  it.each(["cus_other", { id: "cus_other", object: "customer" }, {}, ""])(
    "never detaches with mismatched or invalid customer %j", async (customer) => {
      retrieve.mockResolvedValue(pm(customer));
      await expect(provider.removeSavedCard(input)).rejects.toThrow();
      expect(detach).not.toHaveBeenCalled();
    });
  it("missing expected customer cannot authorize attached-card removal", async () => {
    await expect(provider.removeSavedCard({ ...input, customerId: "" })).rejects.toThrow();
    expect(detach).not.toHaveBeenCalled();
  });
  it.each([
    ["still attached", pm(customerId)],
    ["wrong card", { ...pm(null), id: "pm_other" }],
    ["missing customer", { id: cardId, object: "payment_method", type: "card" }],
    ["wrong object", { ...pm(null), object: "customer" }],
    ["empty", {}],
  ])("invalid detach receipt stays uncertain when read is attached: %s", async (_label, value) => {
    detach.mockResolvedValue(value);
    await expect(provider.removeSavedCard(input)).rejects.toThrow();
    expect(detach).toHaveBeenCalledTimes(1);
  });
  it("response loss is recovered by an exact detached read, no second detach", async () => {
    retrieve.mockResolvedValueOnce(pm(customerId)).mockResolvedValueOnce(pm(null));
    detach.mockRejectedValue(new Error("synthetic response lost"));
    expect(await provider.removeSavedCard(input)).toEqual({ providerReference: cardId });
    expect(detach).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });
  it("malformed detach response is recovered by an exact detached read", async () => {
    retrieve.mockResolvedValueOnce(pm(customerId)).mockResolvedValueOnce(pm(null));
    detach.mockResolvedValue({});
    expect(await provider.removeSavedCard(input)).toEqual({ providerReference: cardId });
    expect(detach).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });
  it("initial read timeout cannot authorize a detach", async () => {
    retrieve.mockRejectedValueOnce(new Error("read timeout")).mockResolvedValueOnce(pm(customerId));
    await expect(provider.removeSavedCard(input)).rejects.toThrow();
    expect(detach).not.toHaveBeenCalled();
  });
  it("response loss and read timeout stay uncertain", async () => {
    retrieve.mockResolvedValueOnce(pm(customerId)).mockRejectedValueOnce(new Error("read timeout"));
    detach.mockRejectedValue(new Error("response lost"));
    await expect(provider.removeSavedCard(input)).rejects.toThrow();
    expect(detach).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...pm(null), id: "pm_other" },
    { id: cardId, object: "payment_method", type: "card" },
  ])("fallback cannot confirm a mismatched/incomplete read %j", async (value) => {
    retrieve.mockResolvedValueOnce(pm(customerId)).mockResolvedValueOnce(value);
    detach.mockRejectedValue(new Error("response lost"));
    await expect(provider.removeSavedCard(input)).rejects.toThrow();
    expect(detach).toHaveBeenCalledTimes(1);
  });
  it("retry after successful detach reads only, never reattaches", async () => {
    detach.mockImplementation(async () => { retrieve.mockResolvedValue(pm(null)); return pm(null); });
    expect(await provider.removeSavedCard(input)).toEqual({ providerReference: cardId });
    expect(await provider.removeSavedCard(input)).toEqual({ providerReference: cardId });
    expect(detach).toHaveBeenCalledTimes(1);
  });
  it("concurrent callers recover the losing detach response through an exact read", async () => {
    let release!: () => void;
    const bothRead = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    retrieve.mockImplementation(async () => {
      reads += 1;
      if (reads <= 2) {
        if (reads === 2) release();
        await bothRead;
        return pm(customerId);
      }
      return pm(null);
    });
    detach.mockResolvedValueOnce(pm(null)).mockRejectedValueOnce(new Error("already detached"));
    expect(await Promise.all([provider.removeSavedCard(input), provider.removeSavedCard(input)]))
      .toEqual([{ providerReference: cardId }, { providerReference: cardId }]);
    expect(detach).toHaveBeenCalledTimes(2);
    expect(retrieve).toHaveBeenCalledTimes(3);
  });
  it("receipt validation does not log raw provider metadata", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      detach.mockResolvedValue({ id: cardId, billing_details: { email: "synthetic@example.test" } });
      await expect(provider.removeSavedCard(input)).rejects.toThrow("stripe_invalid_card_removal_receipt");
      expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); warn.mockRestore(); error.mockRestore(); }
  });
});
