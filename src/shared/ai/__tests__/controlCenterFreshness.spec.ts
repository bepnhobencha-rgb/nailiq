import { describe, expect, it } from "vitest";

import {
  AI_CONTROL_REFRESH_INTERVAL_MS,
  shouldRefreshAiControlCenter,
} from "@/shared/ai/controlCenterFreshness";

describe("AI Control Center freshness", () => {
  it("refreshes a visible stale snapshot", () => {
    expect(
      shouldRefreshAiControlCenter({
        nowMs: 60_000,
        observedAtMs: 0,
        visibilityState: "visible",
      }),
    ).toBe(true);
  });

  it("does not refresh while the tab is hidden", () => {
    expect(
      shouldRefreshAiControlCenter({
        nowMs: 120_000,
        observedAtMs: 0,
        visibilityState: "hidden",
      }),
    ).toBe(false);
  });

  it("does not refresh a fresh snapshot or invalid timestamp", () => {
    expect(
      shouldRefreshAiControlCenter({
        nowMs: 60_000,
        observedAtMs: 30_000,
        visibilityState: "visible",
      }),
    ).toBe(false);
    expect(
      shouldRefreshAiControlCenter({
        nowMs: 60_000,
        observedAtMs: Number.NaN,
        visibilityState: "visible",
      }),
    ).toBe(false);
  });

  it("uses a bounded one-minute polling interval", () => {
    expect(AI_CONTROL_REFRESH_INTERVAL_MS).toBe(60_000);
  });
});
