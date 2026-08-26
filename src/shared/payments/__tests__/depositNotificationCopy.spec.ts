import { describe, expect, it } from "vitest";

import { formatDepositNotificationAmount } from "../depositNotificationCopy";

describe("formatDepositNotificationAmount", () => {
  it("renders zero-decimal currencies from their DB smallest-unit integer", () => {
    const rendered = formatDepositNotificationAmount(250_000, "VND");
    expect(rendered).toContain("250.000");
    expect(rendered).not.toContain("2.500");
  });

  it("renders ordinary two-decimal currencies and rejects unknown currency", () => {
    expect(formatDepositNotificationAmount(2_500, "CAD")).toContain("25.00");
    expect(formatDepositNotificationAmount(2_500, "ZZZ")).toBeNull();
  });
});
