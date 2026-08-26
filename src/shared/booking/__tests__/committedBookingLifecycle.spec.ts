import { describe, expect, it } from "vitest";

import { committedBookingLifecycleError } from "@/shared/booking/committedBookingLifecycle";

const START = "2099-08-21T21:00:00.000Z";

describe("committed booking replay lifecycle", () => {
  it("acknowledges only the exact still-confirmed appointment", () => {
    expect(
      committedBookingLifecycleError({
        status: "confirmed",
        persistedStartTimeUtc: START,
        requestedStartTimeUtc: START,
      }),
    ).toBeNull();
  });

  it.each([
    ["cancelled", START, "booking_cancelled"],
    ["completed", START, "booking_completed"],
    ["in_progress", START, "booking_not_confirmed"],
    ["confirmed", "2099-08-22T21:00:00.000Z", "booking_rescheduled"],
  ])("fails truthfully for status/time %s", (status, persistedStart, error) => {
    expect(
      committedBookingLifecycleError({
        status,
        persistedStartTimeUtc: persistedStart,
        requestedStartTimeUtc: START,
      }),
    ).toBe(error);
  });
});
