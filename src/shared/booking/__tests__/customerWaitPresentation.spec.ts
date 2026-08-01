import { describe, expect, it } from "vitest";

import {
  customerBookingKindFromSource,
  formatCustomerWaitReadyClock,
  resolveCustomerWaitSurface,
} from "../customerWaitPresentation";

describe("customerBookingKindFromSource", () => {
  it("keeps walk-ins on the queue surface", () => {
    expect(customerBookingKindFromSource("walkin")).toBe("walkin");
    expect(customerBookingKindFromSource(" WALKIN ")).toBe("walkin");
  });

  it("treats scheduled and voice bookings as appointments", () => {
    expect(customerBookingKindFromSource("voice_ai")).toBe("appointment");
    expect(customerBookingKindFromSource("online")).toBe("appointment");
    expect(customerBookingKindFromSource(null)).toBe("appointment");
  });
});

describe("resolveCustomerWaitSurface", () => {
  it("shows a confirmed appointment instead of queue wait information", () => {
    expect(resolveCustomerWaitSurface("appointment", "confirmed")).toBe(
      "appointment",
    );
  });

  it("preserves the confirmed walk-in queue experience", () => {
    expect(resolveCustomerWaitSurface("walkin", "confirmed")).toBe("waiting");
  });

  it("preserves terminal and in-progress states", () => {
    expect(resolveCustomerWaitSurface("appointment", "in_progress")).toBe(
      "ready",
    );
    expect(resolveCustomerWaitSurface("walkin", "completed")).toBe("done");
    expect(resolveCustomerWaitSurface("appointment", "cancelled")).toBe(
      "cancelled",
    );
    expect(resolveCustomerWaitSurface("appointment", "no_show")).toBe(
      "cancelled",
    );
  });
});

describe("formatCustomerWaitReadyClock", () => {
  it("formats the initial clock in the salon timezone, not the server timezone", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "UTC";

    try {
      expect(
        formatCustomerWaitReadyClock(
          "2026-07-31T14:30:00.000Z",
          "America/Los_Angeles",
        ),
      ).toBe("7:30 AM");
    } finally {
      if (previousTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTimezone;
      }
    }
  });
});
