import { describe, expect, it } from "vitest";

import { resolveAiControlSource } from "@/shared/ai/controlCenterData";

describe("AI Control Center source resolution", () => {
  it("preserves an observed empty result as available data", () => {
    expect(
      resolveAiControlSource(
        "approvals",
        { status: "fulfilled", value: [] as string[] },
        ["fallback"],
      ),
    ).toEqual({
      value: [],
      unavailableSource: null,
      error: null,
    });
  });

  it("distinguishes a failed read from an observed empty result", () => {
    const error = new Error("database_unavailable");
    expect(
      resolveAiControlSource(
        "execution_queue",
        { status: "rejected", reason: error },
        [] as string[],
      ),
    ).toEqual({
      value: [],
      unavailableSource: "execution_queue",
      error,
    });
  });
});
