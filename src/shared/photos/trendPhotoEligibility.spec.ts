import { describe, expect, it } from "vitest";

import { filterCurrentPublicTrendPhotos } from "../../../supabase/functions/_shared/trendPhotoEligibility";

const salonA = "22222222-2222-4222-8222-222222222222";
const salonB = "33333333-3333-4333-8333-333333333333";
const phoneA = "16045550199";

function photo(input: { salon?: string; bookingSalon?: string; phone?: string } = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    salon_id: input.salon ?? salonA,
    bookings: {
      salon_id: input.bookingSalon ?? salonA,
      client_phone: input.phone ?? phoneA,
    },
  };
}

describe("trend photo public-consent eligibility", () => {
  it("keeps a photo only when booking, salon and current public consent match", () => {
    expect(filterCurrentPublicTrendPhotos(
      [photo()],
      [{
        salon_id: salonA,
        client_phone: phoneA,
        consent_share_public: true,
        revoked_at: null,
      }],
    )).toHaveLength(1);
  });

  it.each([
    ["no consent", []],
    ["private consent", [{ salon_id: salonA, client_phone: phoneA, consent_share_public: false, revoked_at: null }]],
    ["revoked consent", [{ salon_id: salonA, client_phone: phoneA, consent_share_public: true, revoked_at: "2026-09-14T00:00:00Z" }]],
    ["another salon", [{ salon_id: salonB, client_phone: phoneA, consent_share_public: true, revoked_at: null }]],
    ["another customer", [{ salon_id: salonA, client_phone: "16045550000", consent_share_public: true, revoked_at: null }]],
  ])("rejects %s", (_label, consents) => {
    expect(filterCurrentPublicTrendPhotos([photo()], consents)).toEqual([]);
  });

  it("rejects a cross-tenant booking binding", () => {
    expect(filterCurrentPublicTrendPhotos(
      [photo({ bookingSalon: salonB })],
      [{ salon_id: salonA, client_phone: phoneA, consent_share_public: true, revoked_at: null }],
    )).toEqual([]);
  });

  it("accepts PostgREST array-shaped booking relations", () => {
    const candidate = { ...photo(), bookings: [photo().bookings] };
    expect(filterCurrentPublicTrendPhotos(
      [candidate],
      [{ salon_id: salonA, client_phone: phoneA, consent_share_public: true, revoked_at: null }],
    )).toEqual([candidate]);
  });
});
