import { describe, expect, it } from "vitest";
import { recoverWaitlistSlotFromFreshGrid } from "../waitlistSlotRecovery";

describe("Waitlist recovery uses a fresh canonical grid", () => {
  it("selects the recovered time only when it is bookable", () => {
    expect(recoverWaitlistSlotFromFreshGrid("2:00 PM", [
      { label: "2:00 PM", available: true },
      { label: "2:15 PM", available: false },
    ])).toBe("2:00 PM");
  });
  it("does not turn a newly occupied time into an available slot", () => {
    expect(recoverWaitlistSlotFromFreshGrid("2:00 PM", [
      { label: "2:00 PM", available: false },
      { label: "2:15 PM", available: true },
    ])).toBeNull();
  });
  it("fails closed when the fresh availability read returned no slots", () => {
    expect(recoverWaitlistSlotFromFreshGrid("2:00 PM", [])).toBeNull();
  });
  it("does not silently substitute a different time", () => {
    expect(recoverWaitlistSlotFromFreshGrid("2:00 PM", [
      { label: "3:00 PM", available: true },
    ])).toBeNull();
  });
  it("does not mutate the fetched grid", () => {
    const slots = Object.freeze([Object.freeze({ label: "2:00 PM", available: true })]);
    expect(recoverWaitlistSlotFromFreshGrid("2:00 PM", slots)).toBe("2:00 PM");
    expect(slots[0].available).toBe(true);
  });
});
