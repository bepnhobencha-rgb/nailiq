import { describe, it, expect } from "vitest";
import { parseSpokenTime, compareSpokenTimeToSlot } from "../spokenTime";

describe("parseSpokenTime — the forms the spec requires", () => {
  const hour6 = (extra: Partial<{ minute: number | null; period: "am" | "pm" | null }> = {}) =>
    ({ hour12: 6, minute: null, period: null, ...extra });

  it.each([
    ["6", hour6()],
    ["6:00", hour6({ minute: 0 })],
    ["6 PM", hour6({ period: "pm" })],
    ["6:00 PM", hour6({ minute: 0, period: "pm" })],
    ["six", hour6()],
    ["six o'clock", hour6()],
    ["six点", hour6()],
    ["6点", hour6()],
    ["6 giờ", hour6()],
    ["sáu giờ", hour6()],
  ])("parses %j", (input, expected) => {
    expect(parseSpokenTime(input)).toEqual(expected);
  });

  it("reads a 24-hour digit as PM on the 12-hour clock", () => {
    expect(parseSpokenTime("18:00")).toEqual({ hour12: 6, minute: 0, period: "pm" });
  });

  it("returns null when there is no time", () => {
    expect(parseSpokenTime("yes")).toBeNull();
    expect(parseSpokenTime("book appointment please")).toBeNull();
    expect(parseSpokenTime("")).toBeNull();
  });
});

describe("compareSpokenTimeToSlot — the guardrail's decision", () => {
  it("blocks the real bug: 'six' against a 5:30 PM slot", () => {
    expect(compareSpokenTimeToSlot("six", "5:30 PM")).toBe("mismatch");
  });

  it("blocks the transcribed form 'six点' against 5:30 PM", () => {
    expect(compareSpokenTimeToSlot("six点", "5:30 PM")).toBe("mismatch");
  });

  it("allows '6 giờ' against 6:00 PM", () => {
    expect(compareSpokenTimeToSlot("6 giờ", "6:00 PM")).toBe("match");
  });

  it("allows 'six' against any 6 o'clock slot (hour matches, minute unspoken)", () => {
    expect(compareSpokenTimeToSlot("six", "6:00 PM")).toBe("match");
    expect(compareSpokenTimeToSlot("six", "6:30 PM")).toBe("match");
  });

  it("respects an explicit AM/PM disagreement", () => {
    expect(compareSpokenTimeToSlot("6 AM", "6:00 PM")).toBe("mismatch");
    expect(compareSpokenTimeToSlot("6:00 PM", "6:00 PM")).toBe("match");
  });

  it("blocks a spoken minute that disagrees within the right hour", () => {
    expect(compareSpokenTimeToSlot("6:45", "6:00 PM")).toBe("mismatch");
  });

  it("returns unknown (does not block) when no time is spoken", () => {
    expect(compareSpokenTimeToSlot("yes", "6:00 PM")).toBe("unknown");
    expect(compareSpokenTimeToSlot("that works", "6:00 PM")).toBe("unknown");
  });

  it("returns unknown on an unparseable slot", () => {
    expect(compareSpokenTimeToSlot("six", "evening")).toBe("unknown");
  });
});
