import { describe, expect, it } from "vitest";
import { hoursEditorIsValid } from "@/shared/dashboard/hoursSetupValidation";
import { defaultOpeningHoursWeek } from "@/shared/dashboard/openingHoursDefaults";

describe("HoursSetupPanel validation", () => {
  it("rejects impossible calendar dates instead of normalizing them away", () => {
    expect(hoursEditorIsValid(defaultOpeningHoursWeek(), "2026-02-30")).toBe(
      false,
    );
    expect(hoursEditorIsValid(defaultOpeningHoursWeek(), "2028-02-29")).toBe(
      true,
    );
  });
});
