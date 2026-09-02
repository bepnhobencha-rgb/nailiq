import { describe, expect, it } from "vitest";

import {
  parseTurnIqRolloutStage,
  turnIqStageAllowsOfflineMutation,
  turnIqStageAllowsOnlineMutation,
  turnIqStageAllowsRead,
} from "@/shared/turniq/rolloutStage";

describe("TurnIQ rollout stages", () => {
  it("fails unknown or missing state closed to off", () => {
    expect(parseTurnIqRolloutStage(undefined)).toBe("off");
    expect(parseTurnIqRolloutStage("LIVE")).toBe("off");
    expect(parseTurnIqRolloutStage("broken")).toBe("off");
  });

  it("allows shadow reads but blocks every mutation", () => {
    expect(turnIqStageAllowsRead("shadow")).toBe(true);
    expect(turnIqStageAllowsOnlineMutation("shadow")).toBe(false);
    expect(turnIqStageAllowsOfflineMutation("shadow")).toBe(false);
  });

  it("allows supervised online commands but reserves offline writes for live", () => {
    expect(turnIqStageAllowsOnlineMutation("supervised")).toBe(true);
    expect(turnIqStageAllowsOfflineMutation("supervised")).toBe(false);
    expect(turnIqStageAllowsOnlineMutation("live")).toBe(true);
    expect(turnIqStageAllowsOfflineMutation("live")).toBe(true);
  });
});
