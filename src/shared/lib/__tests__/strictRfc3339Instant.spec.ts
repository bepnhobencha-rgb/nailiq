import { describe, expect, it } from "vitest";

import { canonicalizeStrictRfc3339Instant } from "@/shared/lib/strictRfc3339Instant";

describe("canonicalizeStrictRfc3339Instant", () => {
  it("canonicalizes a real explicit-offset instant", () => {
    expect(canonicalizeStrictRfc3339Instant("2026-11-01T01:30:00-07:00")).toBe(
      "2026-11-01T08:30:00.000Z",
    );
  });

  it.each([
    "2026-02-30T10:00:00Z",
    "2025-02-29T10:00:00Z",
    "2026-13-01T10:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T10:60:00Z",
    "2026-01-01T10:00:00",
  ])("rejects an impossible or timezone-free instant: %s", (value) => {
    expect(canonicalizeStrictRfc3339Instant(value)).toBeNull();
  });
});
