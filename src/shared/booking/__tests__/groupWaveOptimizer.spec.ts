import { describe, expect, it } from "vitest";

import {
  buildGroupWaveOptimization,
  ceilTimestampToCadence,
  isGroupWaveStrategy,
  normalizeGroupWaveStrategy,
  resolveGroupWavePolicy,
  selectNextWaveStartMs,
} from "../groupWaveOptimizer";

const MINUTE = 60_000;

describe("Smart Wave Optimizer", () => {
  it("fails closed to the legacy exact policy for missing or invalid config", () => {
    expect(isGroupWaveStrategy("balanced")).toBe(true);
    expect(isGroupWaveStrategy("fastest")).toBe(false);
    expect(normalizeGroupWaveStrategy(null)).toBe("maximize_revenue");
    expect(normalizeGroupWaveStrategy("fastest")).toBe("maximize_revenue");
  });

  it("preserves exact capacity-ready starts by default", () => {
    const policy = resolveGroupWavePolicy();

    expect(policy).toEqual({
      strategy: "maximize_revenue",
      cadenceMinutes: 1,
    });
    expect(selectNextWaveStartMs(70 * MINUTE, policy)).toBe(70 * MINUTE);
  });

  it("supports balanced 5-minute and on-time 15-minute cadences", () => {
    expect(
      selectNextWaveStartMs(67 * MINUTE, resolveGroupWavePolicy("balanced")),
    ).toBe(70 * MINUTE);
    expect(
      selectNextWaveStartMs(67 * MINUTE, resolveGroupWavePolicy("on_time")),
    ).toBe(75 * MINUTE);
  });

  it("applies an explicit gap once before cadence alignment", () => {
    const policy = resolveGroupWavePolicy("balanced");

    expect(selectNextWaveStartMs(60 * MINUTE, policy, 7)).toBe(70 * MINUTE);
    expect(selectNextWaveStartMs(60 * MINUTE, policy, -10)).toBe(60 * MINUTE);
  });

  it("never rounds a safe start backwards", () => {
    expect(ceilTimestampToCadence(67 * MINUTE, 15)).toBeGreaterThanOrEqual(
      67 * MINUTE,
    );
  });

  it("reports recovered capacity separately from money", () => {
    const optimization = buildGroupWaveOptimization(
      [
        { waveNumber: 1, startMs: 0, endMs: 67 * MINUTE },
        { waveNumber: 1, startMs: 0, endMs: 67 * MINUTE },
        { waveNumber: 2, startMs: 70 * MINUTE, endMs: 137 * MINUTE },
        { waveNumber: 2, startMs: 70 * MINUTE, endMs: 137 * MINUTE },
      ],
      resolveGroupWavePolicy("balanced"),
    );

    expect(optimization.recoveredClockMinutes).toBe(5);
    expect(optimization.recoveredCapacityMinutes).toBe(10);
    expect(optimization.addedIdleMinutes).toBe(3);
    expect(optimization).not.toHaveProperty("revenueCents");
  });
});
