import { describe, expect, it } from "vitest";

import {
  customerBookingKindFromSource,
  formatCustomerAppointmentDateTime,
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

describe("formatCustomerAppointmentDateTime", () => {
  it("formats an Anaheim appointment deterministically in English", () => {
    expect(
      formatCustomerAppointmentDateTime(
        "2026-08-20T01:10:00.000Z",
        "America/Los_Angeles",
        "en",
      ),
    ).toBe("Wed, Aug 19, 2026 · 6:10 PM");
  });

  it("formats the same salon-local instant deterministically in Vietnamese", () => {
    expect(
      formatCustomerAppointmentDateTime(
        "2026-08-20T01:10:00.000Z",
        "America/Los_Angeles",
        "vi",
      ),
    ).toBe("T4, 19/08/2026 · 18:10");
  });

  it("does not use localized formatter output that can drift across ICU versions", () => {
    const originalFormat = Intl.DateTimeFormat.prototype.formatToParts;
    const nativeFormatGetter = Object.getOwnPropertyDescriptor(
      Intl.DateTimeFormat.prototype,
      "format",
    );
    Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
      configurable: true,
      get() {
        return () => "runtime-specific text that must not be rendered";
      },
    });

    try {
      expect(
        formatCustomerAppointmentDateTime(
          "2026-08-20T01:10:00.000Z",
          "America/Los_Angeles",
          "en",
        ),
      ).toBe("Wed, Aug 19, 2026 · 6:10 PM");
      expect(Intl.DateTimeFormat.prototype.formatToParts).toBe(originalFormat);
    } finally {
      if (nativeFormatGetter) {
        Object.defineProperty(
          Intl.DateTimeFormat.prototype,
          "format",
          nativeFormatGetter,
        );
      }
    }
  });
});
