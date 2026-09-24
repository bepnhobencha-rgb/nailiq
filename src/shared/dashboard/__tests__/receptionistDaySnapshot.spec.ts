import { describe, expect, it } from "vitest";
import { applyReceptionistDaySnapshot, receptionistDateOffset } from "../receptionistDaySnapshot";

describe("receptionist initial date selection", () => {
  it.each([
    ["2026-09-23", -1], ["2026-09-24", 0], ["2026-09-25", 1], ["2026-10-01", null],
  ] as const)("selects %s from the salon clock before hydration", (date, expected) => {
    expect(receptionistDateOffset(date, "America/Los_Angeles", "2026-09-25T01:30:00Z")).toBe(expected);
  });
  it.each([
    ["2026-03-09", "2026-03-08T10:30:00Z"],
    ["2026-11-02", "2026-11-01T09:30:00Z"],
    ["2027-01-01", "2027-01-01T02:30:00Z"],
  ])("keeps tomorrow correct across DST/year boundaries: %s", (date, clock) => {
    expect(receptionistDateOffset(date, "America/Los_Angeles", clock)).toBe(1);
  });
  it("moves a selected day from tomorrow to today at salon midnight", () => {
    expect(receptionistDateOffset("2026-09-25", "America/Los_Angeles", "2026-09-25T06:59:00Z")).toBe(1);
    expect(receptionistDateOffset("2026-09-25", "America/Los_Angeles", "2026-09-25T07:00:00Z")).toBe(0);
  });
});

describe("receptionist background day snapshots", () => {
  it("rejects a today's reload that resolves after tomorrow has been selected", async () => {
    const today = { selectedDate: "2026-09-24", bookings: ["today"] };
    const tomorrow = { selectedDate: "2026-09-25", bookings: ["future-booking"] };
    let current = today;
    let resolveReload!: (value: typeof today) => void;
    const response = new Promise<typeof today>((resolve) => { resolveReload = resolve; });
    const requestedDate = current.selectedDate;
    const backgroundReload = response.then((snapshot) => {
      current = applyReceptionistDaySnapshot(current, snapshot, requestedDate);
    });

    current = tomorrow;
    resolveReload({ ...today, bookings: ["late-today-response"] });
    await backgroundReload;

    expect(current).toBe(tomorrow);
    expect(current.bookings).toEqual(["future-booking"]);
  });

  it("adopts fresh data when request, response, and viewed date match", () => {
    const current = { selectedDate: "2026-09-24", bookings: ["old"] };
    const response = { selectedDate: "2026-09-24", bookings: ["fresh"] };
    expect(applyReceptionistDaySnapshot(current, response, current.selectedDate)).toBe(response);
  });

  it("does not adopt a response for an unexpected day", () => {
    const current = { selectedDate: "2026-09-25", bookings: ["future-booking"] };
    const response = { selectedDate: "2026-09-24", bookings: ["today"] };
    expect(applyReceptionistDaySnapshot(current, response, current.selectedDate)).toBe(current);
  });
});
