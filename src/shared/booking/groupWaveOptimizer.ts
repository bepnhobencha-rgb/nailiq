/**
 * Deterministic policy layer for large-group wave timing.
 *
 * The scheduler remains the source of truth for feasibility. This module only
 * decides how an already-safe capacity-ready timestamp is presented as the
 * next synchronized wave start. It deliberately does not claim incremental
 * revenue: an earlier start recovers bookable capacity, but only a later
 * provider-confirmed payment can prove collected revenue.
 */

export const GROUP_WAVE_STRATEGIES = [
  "maximize_revenue",
  "balanced",
  "on_time",
] as const;

export type GroupWaveStrategy = (typeof GROUP_WAVE_STRATEGIES)[number];

export function isGroupWaveStrategy(value: unknown): value is GroupWaveStrategy {
  return (
    typeof value === "string" &&
    (GROUP_WAVE_STRATEGIES as readonly string[]).includes(value)
  );
}

export function normalizeGroupWaveStrategy(value: unknown): GroupWaveStrategy {
  return isGroupWaveStrategy(value) ? value : "maximize_revenue";
}

export type GroupWavePolicy = {
  strategy: GroupWaveStrategy;
  /** Customer-facing cadence used for later-wave starts. */
  cadenceMinutes: 1 | 5 | 15;
};

export type GroupWaveDecision = {
  waveNumber: number;
  /** First safe instant after the prior wave block and explicit gap. */
  capacityReadyMs: number;
  /** Start selected by the policy. */
  scheduledStartMs: number;
  /** Comparable customer-friendly 15-minute-grid start. */
  baselineGridStartMs: number;
  memberCount: number;
  /** Clock minutes gained compared with waiting for the 15-minute grid. */
  recoveredClockMinutes: number;
  /** Clock minutes gained multiplied by members in this wave. */
  recoveredCapacityMinutes: number;
  /** Intentional idle minutes inserted after capacity is safe. */
  addedIdleMinutes: number;
};

export type GroupWaveOptimization = {
  strategy: GroupWaveStrategy;
  cadenceMinutes: 1 | 5 | 15;
  baselineCadenceMinutes: 15;
  recoveredClockMinutes: number;
  recoveredCapacityMinutes: number;
  addedIdleMinutes: number;
  decisions: GroupWaveDecision[];
};

export type WaveTimingAssignment = {
  waveNumber: number;
  startMs: number;
  endMs: number;
};

export type WaveCapacityReady = {
  waveNumber: number;
  /** Safe instant after the relevant capacity release and explicit gap. */
  capacityReadyMs: number;
};

const MINUTE_MS = 60_000;

export function resolveGroupWavePolicy(
  strategy: GroupWaveStrategy = "maximize_revenue",
): GroupWavePolicy {
  switch (strategy) {
    case "balanced":
      return { strategy, cadenceMinutes: 5 };
    case "on_time":
      return { strategy, cadenceMinutes: 15 };
    case "maximize_revenue":
    default:
      // One-minute precision preserves the current exact, flush wave behavior.
      return { strategy: "maximize_revenue", cadenceMinutes: 1 };
  }
}

export function ceilTimestampToCadence(
  timestampMs: number,
  cadenceMinutes: number,
): number {
  const cadenceMs = Math.max(1, Math.trunc(cadenceMinutes)) * MINUTE_MS;
  return Math.ceil(timestampMs / cadenceMs) * cadenceMs;
}

/**
 * Return the next policy-aligned start after a relevant staff lane is safe.
 * `explicitGapMinutes` is a deliberate salon policy and is separate from the
 * per-service buffer already included in every assignment block.
 */
export function selectNextWaveStartMs(
  capacityReleaseMs: number,
  policy: GroupWavePolicy,
  explicitGapMinutes = 0,
): number {
  const capacityReadyMs =
    capacityReleaseMs + Math.max(0, explicitGapMinutes) * MINUTE_MS;
  return ceilTimestampToCadence(capacityReadyMs, policy.cadenceMinutes);
}

/** Build owner-safe utilization evidence without presenting it as money. */
export function buildGroupWaveOptimization(
  assignments: readonly WaveTimingAssignment[],
  policy: GroupWavePolicy,
  explicitGapMinutes = 0,
  capacityReadyByWave: readonly WaveCapacityReady[] = [],
): GroupWaveOptimization {
  const waveNumbers = [...new Set(assignments.map((a) => a.waveNumber))].sort(
    (a, b) => a - b,
  );
  const decisions: GroupWaveDecision[] = [];
  const explicitCapacityReady = new Map(
    capacityReadyByWave.map((entry) => [entry.waveNumber, entry.capacityReadyMs]),
  );

  for (let index = 1; index < waveNumbers.length; index++) {
    const previousWaveNumber = waveNumbers[index - 1];
    const waveNumber = waveNumbers[index];
    const previous = assignments.filter(
      (assignment) => assignment.waveNumber === previousWaveNumber,
    );
    const current = assignments.filter(
      (assignment) => assignment.waveNumber === waveNumber,
    );
    if (previous.length === 0 || current.length === 0) continue;

    const previousWaveEndMs = Math.max(...previous.map((a) => a.endMs));
    const capacityReadyMs =
      explicitCapacityReady.get(waveNumber) ??
      previousWaveEndMs + Math.max(0, explicitGapMinutes) * MINUTE_MS;
    const scheduledStartMs = Math.min(...current.map((a) => a.startMs));
    const baselineGridStartMs = ceilTimestampToCadence(capacityReadyMs, 15);
    const recoveredClockMinutes = Math.max(
      0,
      Math.round((baselineGridStartMs - scheduledStartMs) / MINUTE_MS),
    );
    const addedIdleMinutes = Math.max(
      0,
      Math.round((scheduledStartMs - capacityReadyMs) / MINUTE_MS),
    );

    decisions.push({
      waveNumber,
      capacityReadyMs,
      scheduledStartMs,
      baselineGridStartMs,
      memberCount: current.length,
      recoveredClockMinutes,
      recoveredCapacityMinutes: recoveredClockMinutes * current.length,
      addedIdleMinutes,
    });
  }

  return {
    strategy: policy.strategy,
    cadenceMinutes: policy.cadenceMinutes,
    baselineCadenceMinutes: 15,
    recoveredClockMinutes: decisions.reduce(
      (sum, decision) => sum + decision.recoveredClockMinutes,
      0,
    ),
    recoveredCapacityMinutes: decisions.reduce(
      (sum, decision) => sum + decision.recoveredCapacityMinutes,
      0,
    ),
    addedIdleMinutes: decisions.reduce(
      (sum, decision) => sum + decision.addedIdleMinutes,
      0,
    ),
    decisions,
  };
}
