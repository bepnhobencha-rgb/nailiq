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

function squareFetch({ bookingProfile = true } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
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
      validateSquareProductionConnection("secret-production-token", fetchMock),
    ).resolves.toEqual({
      merchantId: "M_STUDIO",
      merchantBusinessName: "Studio Legal Company",
      locationId: "L_STUDIO",
      locationName: "Hi-Lite Studio",
      currency: "USD",
      bookingSyncReady: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(fetchMock).mock.calls) {
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
      validateSquareProductionConnection("secret-production-token", fetchMock),
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
});
