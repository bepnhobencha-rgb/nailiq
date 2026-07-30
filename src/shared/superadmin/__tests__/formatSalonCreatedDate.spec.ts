import { describe, expect, it } from "vitest";

import { formatSalonCreatedDate } from "../formatSalonCreatedDate";

describe("formatSalonCreatedDate", () => {
  it("formats dates in UTC at a browser timezone boundary", () => {
    expect(formatSalonCreatedDate("2026-07-30T00:30:00.000Z")).toBe(
      "Jul 30, 2026",
    );
  });

  it("returns an em dash for missing or invalid timestamps", () => {
    expect(formatSalonCreatedDate(null)).toBe("—");
    expect(formatSalonCreatedDate("not-a-date")).toBe("—");
  });
});
