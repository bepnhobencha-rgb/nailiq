import { describe, expect, it, vi } from "vitest";
import {
  SquareConnectionValidationError,
  validateSquareProductionConnection,
} from "@/shared/integrations/square/connectValidation";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const APPLICATION_ID = "sq0idp-nailiq-studio";

function squareFetch({ bookingProfile = true } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/oauth2/token/status")) {
      return jsonResponse({
        client_id: APPLICATION_ID,
        merchant_id: "M_STUDIO",
      });
    }
    if (url.endsWith("/locations")) {
      return jsonResponse({
        locations: [
          {
            id: "L_STUDIO",
            merchant_id: "M_STUDIO",
            name: "Hi-Lite Studio",
            status: "ACTIVE",
            currency: "USD",
          },
        ],
      });
    }
    if (url.endsWith("/merchants")) {
      return jsonResponse({
        merchant: [
          { id: "M_STUDIO", business_name: "Studio Legal Company" },
        ],
      });
    }
    if (url.endsWith("/bookings/location-booking-profiles")) {
      return jsonResponse({
        location_booking_profiles: bookingProfile
          ? [{ location_id: "L_STUDIO" }]
          : [],
      });
    }
    return jsonResponse({}, 404);
  }) as unknown as typeof fetch;
}

describe("validateSquareProductionConnection", () => {
  it("returns one verified merchant/location without writing to Square", async () => {
    const fetchMock = squareFetch();

    await expect(
      validateSquareProductionConnection(
        "secret-production-token",
        APPLICATION_ID,
        fetchMock,
      ),
    ).resolves.toEqual({
      merchantId: "M_STUDIO",
      merchantBusinessName: "Studio Legal Company",
      locationId: "L_STUDIO",
      locationName: "Hi-Lite Studio",
      currency: "USD",
      bookingSyncReady: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const calls = vi.mocked(fetchMock).mock.calls;
    expect(String(calls[0][0])).toContain("/oauth2/token/status");
    expect((calls[0][1] as RequestInit).method).toBe("POST");
    for (const call of calls.slice(1)) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(init.cache).toBe("no-store");
    }
  });

  it("allows payments but disables booking sync when no booking profile exists", async () => {
    await expect(
      validateSquareProductionConnection(
        "secret-production-token",
        APPLICATION_ID,
        squareFetch({ bookingProfile: false }),
      ),
    ).resolves.toMatchObject({
      locationId: "L_STUDIO",
      bookingSyncReady: false,
    });
  });

  it("refuses to guess when more than one active location exists", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token/status")) {
        return jsonResponse({
          client_id: APPLICATION_ID,
          merchant_id: "M1",
        });
      }
      if (url.endsWith("/locations")) {
        return jsonResponse({
          locations: [
            { id: "L1", merchant_id: "M1", status: "ACTIVE" },
            { id: "L2", merchant_id: "M1", status: "ACTIVE" },
          ],
        });
      }
      return jsonResponse({ merchant: [{ id: "M1" }] });
    }) as unknown as typeof fetch;

    await expect(
      validateSquareProductionConnection(
        "secret-production-token",
        APPLICATION_ID,
        fetchMock,
      ),
    ).rejects.toMatchObject({
      code: "location_ambiguous",
    });
  });

  it("maps authentication failures without exposing provider payloads", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ errors: [{ detail: "secret-production-token" }] }, 401),
    ) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await validateSquareProductionConnection(
        "secret-production-token",
        APPLICATION_ID,
        fetchMock,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SquareConnectionValidationError);
    expect((caught as SquareConnectionValidationError).code).toBe(
      "invalid_credentials",
    );
    expect(String(caught)).not.toContain("secret-production-token");
  });

  it.each([
    ["ACCESS_TOKEN_EXPIRED", "token_expired", 401],
    ["ACCESS_TOKEN_REVOKED", "token_revoked", 401],
    ["CLIENT_DISABLED", "client_disabled", 401],
    ["INSUFFICIENT_SCOPES", "insufficient_scopes", 403],
    ["FORBIDDEN", "square_forbidden", 403],
  ])(
    "maps Square %s without exposing provider details",
    async (providerCode, expectedCode, status) => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          { errors: [{ code: providerCode, detail: "private provider detail" }] },
          status,
        ),
      ) as unknown as typeof fetch;

      await expect(
        validateSquareProductionConnection(
          "secret-production-token",
          APPLICATION_ID,
          fetchMock,
        ),
      ).rejects.toMatchObject({ code: expectedCode });
    },
  );

  it("rejects a token issued to a different Square application", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        client_id: "sq0idp-another-application",
        merchant_id: "M_STUDIO",
      }),
    ) as unknown as typeof fetch;

    await expect(
      validateSquareProductionConnection(
        "secret-production-token",
        APPLICATION_ID,
        fetchMock,
      ),
    ).rejects.toMatchObject({ code: "credential_identity_mismatch" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a token merchant that differs from the discovered location", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token/status")) {
        return jsonResponse({
          client_id: APPLICATION_ID,
          merchant_id: "M_TOKEN",
        });
      }
      if (url.endsWith("/locations")) {
        return jsonResponse({
          locations: [
            {
              id: "L_STUDIO",
              merchant_id: "M_LOCATION",
              status: "ACTIVE",
            },
          ],
        });
      }
      if (url.endsWith("/merchants")) {
        return jsonResponse({ merchant: [{ id: "M_LOCATION" }] });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    await expect(
      validateSquareProductionConnection(
        "secret-production-token",
        APPLICATION_ID,
        fetchMock,
      ),
    ).rejects.toMatchObject({ code: "credential_identity_mismatch" });
  });
});
