import { describe, expect, it } from "vitest";

import {
  buildMinimumServiceMinutesByStaff,
  canOfferGridCreateStart,
} from "@/shared/booking/gridCreateAvailability";

describe("receptionist grid create availability", () => {
  it("excludes add-ons when finding the shortest bookable service", () => {
    expect(
      buildMinimumServiceMinutesByStaff({
        staffIds: ["anna", "bella"],
        services: [
          { id: "classic", durationMinutes: 60, isAddon: false },
          { id: "deluxe", durationMinutes: 80, isAddon: false },
          { id: "eye-mask", durationMinutes: 5, isAddon: true },
        ],
        capabilityRows: null,
      }),
    ).toEqual({ anna: 60, bella: 60 });
  });

  it("uses staff capability rows and marks staff with no main service unavailable", () => {
    expect(
      buildMinimumServiceMinutesByStaff({
        staffIds: ["anna", "bella"],
        services: [
          { id: "classic", durationMinutes: 60, isAddon: false },
          { id: "special", durationMinutes: 70, isAddon: false },
          { id: "eye-mask", durationMinutes: 5, isAddon: true },
        ],
        capabilityRows: [
          { staffId: "anna", serviceId: "special" },
          { staffId: "bella", serviceId: "eye-mask" },
        ],
      }),
    ).toEqual({ anna: 70, bella: null });
  });

  it("offers 6:30 PM but blocks 6:45 PM and 7:00 PM for a 60-minute minimum", () => {
    const base = {
      staffIsActive: true,
      openMinutes: 9 * 60,
      closeMinutes: 19 * 60 + 30,
      minimumServiceMinutes: 60,
    };

    expect(
      canOfferGridCreateStart({ ...base, startMinutes: 18 * 60 + 30 }),
    ).toBe(true);
    expect(
      canOfferGridCreateStart({ ...base, startMinutes: 18 * 60 + 45 }),
    ).toBe(false);
    expect(
      canOfferGridCreateStart({ ...base, startMinutes: 19 * 60 }),
    ).toBe(false);
  });

  it("keeps a trailing cleanup buffer out of the create-start boundary", () => {
    expect(
      canOfferGridCreateStart({
        staffIsActive: true,
        startMinutes: 18 * 60 + 30,
        openMinutes: 9 * 60,
        closeMinutes: 19 * 60 + 30,
        minimumServiceMinutes: 60,
      }),
    ).toBe(true);
  });
});
