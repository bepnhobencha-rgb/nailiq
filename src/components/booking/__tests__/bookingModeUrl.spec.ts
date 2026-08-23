import { describe, expect, it } from "vitest";

import { bookingModeHref } from "../bookingModeUrl";

describe("bookingModeHref", () => {
  it.each([
    ["individual", "", null],
    ["individual", "lang=vi", null],
    ["group", "lang=vi&mode=group", null],
    ["sequence", "mode=sequence&lang=en", null],
  ] as const)(
    "does not navigate when %s already matches the URL",
    (mode, currentSearch, expected) => {
      expect(bookingModeHref("/salon", currentSearch, mode)).toBe(expected);
    },
  );

  it.each([
    ["group", "lang=vi", "/salon?lang=vi&mode=group"],
    ["sequence", "mode=group", "/salon?mode=sequence"],
    ["individual", "lang=en&mode=group", "/salon?lang=en"],
  ] as const)(
    "returns one canonical replacement when changing to %s",
    (mode, currentSearch, expected) => {
      expect(bookingModeHref("/salon", currentSearch, mode)).toBe(expected);
    },
  );
});
