import { describe, expect, it } from "vitest";

import { isSourceOwnedOperationalException } from "@/shared/ai/operationalExceptionTypes";

describe("operational exception lifecycle ownership", () => {
  it.each(["ai_execution", "ai_manager", "readiness"])(
    "keeps %s recovery source-owned",
    (sourceType) => {
      expect(isSourceOwnedOperationalException(sourceType)).toBe(true);
    },
  );

  it("allows manual lifecycle for human-owned exceptions", () => {
    expect(isSourceOwnedOperationalException("legacy_watchdog")).toBe(false);
    expect(isSourceOwnedOperationalException("manual")).toBe(false);
  });
});
