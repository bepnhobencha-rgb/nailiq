import { afterEach, describe, expect, it, vi } from "vitest";
import { getCustomer, type SquareConfig } from "../client";

const config: SquareConfig = {
  salonId: "63000000-0000-4000-8000-000000000001",
  merchantId: "merchant-local",
  locationId: "location-local",
  accessToken: "fake-local-token",
  applicationId: "fake-local-app",
  environment: "sandbox",
  currency: "CAD",
  sync: {
    pullCreate: true,
    pullUpdate: true,
    pullCancel: true,
    pushCreate: false,
    pushUpdate: false,
    pushCancel: false,
  },
};

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("Square customer lookup failure truth", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns null only for a definitive provider 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(404, {
      errors: [{ code: "NOT_FOUND", detail: "private provider detail" }],
    })));

    await expect(getCustomer(config, "private-customer-id")).resolves.toBeNull();
  });

  it.each([
    ["rate limit", () => response(429, {
      errors: [{ code: "RATE_LIMITED", detail: "private provider detail" }],
    })],
    ["malformed success", () => response(200, { customer: { given_name: "Missing id" } })],
    ["malformed customer material", () => response(200, {
      customer: { id: "private-customer-id", email_address: { value: "not-a-string" } },
    })],
  ])("fails with a stable PII-free code on %s", async (_label, makeResponse) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse()));

    const outcome = getCustomer(config, "private-customer-id");
    await expect(outcome).rejects.toThrow("square_customer_lookup_failed");
    await expect(outcome).rejects.not.toThrow("private-customer-id");
    await expect(outcome).rejects.not.toThrow("private provider detail");
  });

  it("sanitizes transport failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      new TypeError("network failed for private-customer-id"),
    ));

    const outcome = getCustomer(config, "private-customer-id");
    await expect(outcome).rejects.toThrow("square_customer_lookup_failed");
    await expect(outcome).rejects.not.toThrow("private-customer-id");
  });
});
