import { describe, expect, it } from "vitest";
import { bookingEn } from "@/shared/i18n/booking/en";
import { bookingVi } from "@/shared/i18n/booking/vi";
import {
  BOOKING_AVAILABILITY_ERROR,
  bookingTimeSlotAriaLabel,
  resolveBookingAvailabilityError,
} from "../bookingAvailabilityFeedback";

describe("booking availability feedback keeps meaning across language changes", () => {
  it.each([
    [BOOKING_AVAILABILITY_ERROR.slotJustTaken, bookingEn.bookingErrors.slotJustTaken, bookingVi.bookingErrors.slotJustTaken],
    [BOOKING_AVAILABILITY_ERROR.waitlistUnverified, bookingEn.waitlistAvailabilityUnverified, bookingVi.waitlistAvailabilityUnverified],
    [BOOKING_AVAILABILITY_ERROR.gridUnverified, bookingEn.availabilityGridUnverified, bookingVi.availabilityGridUnverified],
  ])("renders the same %s state in the current locale", (code, en, vi) => {
    expect(resolveBookingAvailabilityError(code, bookingEn)).toBe(en);
    expect(resolveBookingAvailabilityError(code, bookingVi)).toBe(vi);
    expect(resolveBookingAvailabilityError(code, bookingEn)).toBe(en);
    expect(en).not.toBe(vi);
  });
  it("cleared errors stay cleared in either language", () => {
    expect(resolveBookingAvailabilityError(null, bookingEn)).toBeNull();
    expect(resolveBookingAvailabilityError(null, bookingVi)).toBeNull();
  });
  it.each(["pricing_changed", "invalid_phone", "A separate existing message"])("preserves the existing %s contract", error => {
    expect(resolveBookingAvailabilityError(error, bookingVi)).toBe(error);
  });
});

describe("time-slot accessible names", () => {
  it("localizes disabled state without changing the canonical time or capacity", () => {
    const slot = Object.freeze({label: "2:00 PM", available: false});
    expect(bookingTimeSlotAriaLabel(slot, bookingEn, false)).toBe("2:00 PM (not available)");
    expect(bookingTimeSlotAriaLabel(slot, bookingVi, false)).toBe("2:00 PM (không còn chỗ)");
    expect(slot.available).toBe(false);
  });
  it("localizes popular slots", () => {
    const slot = {label: "2:00 PM", available: true};
    expect(bookingTimeSlotAriaLabel(slot, bookingVi, true)).toBe("2:00 PM (Phổ biến)");
    expect(bookingTimeSlotAriaLabel(slot, bookingEn, true)).toBe("2:00 PM (Popular)");
  });
  it("keeps recommendation ahead of popularity", () => {
    expect(bookingTimeSlotAriaLabel({label: "2:00 PM", available: true, scoringLabel: "recommended"}, bookingVi, true))
      .toBe("2:00 PM (Gợi ý)");
  });
  it("keeps best fit ahead of popularity", () => {
    expect(bookingTimeSlotAriaLabel({label: "2:00 PM", available: true, scoringLabel: "best_fit"}, bookingVi, true))
      .toBe("2:00 PM (Phù hợp nhất)");
  });
  it("keeps disabled state ahead of any recommendation", () => {
    expect(bookingTimeSlotAriaLabel({label: "2:00 PM", available: false, scoringLabel: "best_fit"}, bookingVi, true))
      .toBe("2:00 PM (không còn chỗ)");
  });
  it("does not decorate ordinary available slots", () => {
    expect(bookingTimeSlotAriaLabel({label: "2:00 PM", available: true}, bookingVi, false)).toBe("2:00 PM");
  });
});
