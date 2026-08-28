import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSquareBooking,
  ensureSquareCustomer,
  type SquareConfig,
} from "../client";

const config: SquareConfig = {
  salonId: "11111111-1111-4111-8111-111111111111",
  merchantId: "merchant-1",
  locationId: "location-1",
  accessToken: "sandbox-token",
  applicationId: "sandbox-app-1",
  environment: "sandbox",
  currency: "CAD",
  sync: {
    pullCreate: true,
    pullUpdate: true,
    pullCancel: true,
    pushCreate: true,
    pushUpdate: false,
    pushCancel: false,
  },
};

const customerInput = {
  name: "QA Guest",
  phone: "+16045550101",
  email: "qa@nailiq.invalid",
  referenceId: "booking:22222222-2222-4222-8222-222222222222",
  idempotencyKey: "sqcust:22222222-2222-4222-8222-222222222222",
};

function response(
  status: number,
  body: Record<string, unknown>,
): { ok: boolean; status: number; json: () => Promise<Record<string, unknown>> } {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function createRequests(fetcher: ReturnType<typeof vi.fn>) {
  return fetcher.mock.calls.filter(([rawUrl]) => (
    new URL(String(rawUrl)).pathname === "/v2/customers"
  ));
}

describe("Square customer create idempotency", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not create a customer when the phone search outcome is unknown", async () => {
    for (const searchFailure of [
      new TypeError("connection reset during customer search"),
      response(503, { errors: [{ code: "SERVICE_UNAVAILABLE" }] }),
    ]) {
      const fetcher = vi.fn(async (rawUrl: string | URL | Request) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path !== "/v2/customers/search") {
          return response(200, { customer: { id: "must-not-be-created" } });
        }
        if (searchFailure instanceof Error) throw searchFailure;
        return searchFailure;
      });
      vi.stubGlobal("fetch", fetcher);

      await expect(ensureSquareCustomer(config, customerInput)).rejects.toThrow();
      expect(createRequests(fetcher)).toHaveLength(0);
      vi.unstubAllGlobals();
    }
  });

  it("treats Square's documented empty object as a definitive no-match", async () => {
    const fetcher = vi.fn(async (rawUrl: string | URL | Request) => {
      const path = new URL(String(rawUrl)).pathname;
      if (path === "/v2/customers/search") return response(200, {});
      return response(200, { customer: { id: "square-customer-1" } });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(ensureSquareCustomer(config, customerInput))
      .resolves.toBe("square-customer-1");
    expect(createRequests(fetcher)).toHaveLength(1);
  });

  it("does not create after a successful-but-malformed phone search response", async () => {
    for (const malformedSearch of [
      { customers: null },
      { customers: {} },
      { customers: [{}] },
      { customers: [], cursor: "unexpected-next-page" },
      { errors: [{ code: "INTERNAL_ERROR" }] },
    ]) {
      const fetcher = vi.fn(async (rawUrl: string | URL | Request) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === "/v2/customers/search") {
          return response(200, malformedSearch);
        }
        return response(200, { customer: { id: "must-not-be-created" } });
      });
      vi.stubGlobal("fetch", fetcher);

      await expect(ensureSquareCustomer(config, customerInput)).rejects.toThrow(
        "Square SearchCustomers returned an invalid response",
      );
      expect(createRequests(fetcher)).toHaveLength(0);
      vi.unstubAllGlobals();
    }
  });

  it("does not dispatch the -np key after an ambiguous transport failure", async () => {
    const fetcher = vi.fn(async (rawUrl: string | URL | Request) => {
      const path = new URL(String(rawUrl)).pathname;
      if (path === "/v2/customers/search") return response(200, { customers: [] });
      throw new TypeError("connection reset after request write");
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(ensureSquareCustomer(config, customerInput)).rejects.toThrow(
      "connection reset after request write",
    );

    const creates = createRequests(fetcher);
    expect(creates).toHaveLength(1);
    expect(JSON.parse(String(creates[0]?.[1]?.body))).toMatchObject({
      idempotency_key: customerInput.idempotencyKey,
      phone_number: customerInput.phone,
    });
  });

  it("does not dispatch the -np key for a 5xx or mixed 4xx response", async () => {
    for (const providerFailure of [
      response(503, { errors: [{ code: "SERVICE_UNAVAILABLE" }] }),
      response(408, { errors: [{ code: "INVALID_PHONE_NUMBER" }] }),
      response(400, {
        errors: [
          { code: "INVALID_PHONE_NUMBER" },
          { code: "BAD_REQUEST" },
        ],
      }),
      response(400, {
        errors: [{ code: "INVALID_PHONE_NUMBER" }, { detail: "unknown" }],
      }),
    ]) {
      const fetcher = vi.fn(async (rawUrl: string | URL | Request) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === "/v2/customers/search") return response(200, { customers: [] });
        return providerFailure;
      });
      vi.stubGlobal("fetch", fetcher);

      await expect(ensureSquareCustomer(config, customerInput)).rejects.toThrow();
      expect(createRequests(fetcher)).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });

  it("uses -np exactly once for a definitive INVALID_PHONE_NUMBER rejection", async () => {
    let createAttempt = 0;
    const fetcher = vi.fn(async (rawUrl: string | URL | Request) => {
      const path = new URL(String(rawUrl)).pathname;
      if (path === "/v2/customers/search") return response(200, { customers: [] });
      createAttempt += 1;
      if (createAttempt === 1) {
        return response(400, { errors: [{ code: "INVALID_PHONE_NUMBER" }] });
      }
      return response(200, { customer: { id: "square-customer-1" } });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(ensureSquareCustomer(config, customerInput))
      .resolves.toBe("square-customer-1");

    const creates = createRequests(fetcher);
    expect(creates).toHaveLength(2);
    expect(JSON.parse(String(creates[0]?.[1]?.body))).toMatchObject({
      idempotency_key: customerInput.idempotencyKey,
      phone_number: customerInput.phone,
    });
    expect(JSON.parse(String(creates[1]?.[1]?.body))).toEqual({
      idempotency_key: "sqc:22222222-2222-4222-8222-222222222222-np",
      given_name: "QA",
      family_name: "Guest",
      email_address: customerInput.email,
      reference_id: customerInput.referenceId,
    });
    expect(JSON.parse(String(creates[1]?.[1]?.body)).idempotency_key)
      .toHaveLength(43);
  });

  it("does not accept a malformed customer-create receipt", async () => {
    const fetcher = vi.fn(async (rawUrl: string | URL | Request) => {
      const path = new URL(String(rawUrl)).pathname;
      if (path === "/v2/customers/search") return response(200, { customers: [] });
      return response(200, { customer: { id: 12345 } });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(ensureSquareCustomer(config, customerInput)).rejects.toThrow(
      "Square CreateCustomer returned no id",
    );
    expect(createRequests(fetcher)).toHaveLength(1);
  });
});

describe("Square booking create receipt", () => {
  afterEach(() => vi.unstubAllGlobals());

  const bookingInput = {
    startAtIso: "2026-08-24T17:00:00.000Z",
    customerId: "square-customer-1",
    teamMemberId: "square-team-member-1",
    serviceVariationId: "square-variation-1",
    serviceVariationVersion: 7,
    durationMinutes: 30,
    sellerNote: "NailIQ booking:22222222-2222-4222-8222-222222222222",
    idempotencyKey: "create:22222222-2222-4222-8222-222222222222",
  };

  it("treats a successful response without an exact version as ambiguous", async () => {
    const fetcher = vi.fn(async () => response(200, {
      booking: { id: "square-booking-created-without-version" },
    }));
    vi.stubGlobal("fetch", fetcher);

    await expect(createSquareBooking(config, bookingInput)).rejects.toThrow(
      "Square CreateBooking returned no exact receipt",
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not accept a non-string booking id as an exact receipt", async () => {
    const fetcher = vi.fn(async () => response(200, {
      booking: { id: 12345, version: 9 },
    }));
    vi.stubGlobal("fetch", fetcher);

    await expect(createSquareBooking(config, bookingInput)).rejects.toThrow(
      "Square CreateBooking returned no exact receipt",
    );
  });

  it("rejects a 200 booking receipt whose returned material differs", async () => {
    const fetcher = vi.fn(async () => response(200, {
      booking: {
        id: "square-booking-wrong-material",
        version: 9,
        status: "ACCEPTED",
        location_id: config.locationId,
        customer_id: "different-square-customer",
        start_at: bookingInput.startAtIso,
        seller_note: bookingInput.sellerNote,
        appointment_segments: [{
          duration_minutes: bookingInput.durationMinutes,
          team_member_id: bookingInput.teamMemberId,
          service_variation_id: bookingInput.serviceVariationId,
          service_variation_version: bookingInput.serviceVariationVersion,
        }],
      },
    }));
    vi.stubGlobal("fetch", fetcher);

    await expect(createSquareBooking(config, bookingInput)).rejects.toThrow(
      "Square CreateBooking returned no exact receipt",
    );
  });

  it("accepts only a fully matching active booking receipt", async () => {
    const fetcher = vi.fn(async () => response(200, {
      booking: {
        id: "square-booking-exact",
        version: 9,
        status: "ACCEPTED",
        location_id: config.locationId,
        customer_id: bookingInput.customerId,
        start_at: bookingInput.startAtIso,
        seller_note: bookingInput.sellerNote,
        appointment_segments: [{
          duration_minutes: bookingInput.durationMinutes,
          team_member_id: bookingInput.teamMemberId,
          service_variation_id: bookingInput.serviceVariationId,
          service_variation_version: bookingInput.serviceVariationVersion,
        }],
      },
    }));
    vi.stubGlobal("fetch", fetcher);

    await expect(createSquareBooking(config, bookingInput)).resolves.toEqual({
      id: "square-booking-exact",
      version: 9,
    });
  });
});
