// Per-salon thresholds for the Clients lifecycle segmentation (new / regular /
// at-risk). Stored as jsonb on salons.client_segment_settings; NULL = defaults
// that reproduce the previous hardcoded behaviour exactly (new ≤ 1 visit,
// at-risk after 60 days). One place owns the defaults + clamps so the settings
// form, the save action, and the Clients panel never drift.

export type ClientSegmentSettings = {
  /** A client with this many or fewer visits is "New". */
  newMaxVisits: number;
  /** A returning client with no visit in this many days is "At-risk". */
  atRiskDays: number;
};

export const CLIENT_SEGMENT_DEFAULTS: ClientSegmentSettings = {
  newMaxVisits: 1,
  atRiskDays: 60,
};

export const CLIENT_SEGMENT_BOUNDS = {
  newMaxVisits: { min: 1, max: 50 },
  atRiskDays: { min: 7, max: 365 },
} as const;

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Normalize raw jsonb (or a form payload) into clamped, defaulted thresholds. */
export function parseClientSegmentSettings(raw: unknown): ClientSegmentSettings {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    newMaxVisits: clampInt(
      obj["new_max_visits"] ?? obj["newMaxVisits"],
      CLIENT_SEGMENT_DEFAULTS.newMaxVisits,
      CLIENT_SEGMENT_BOUNDS.newMaxVisits.min,
      CLIENT_SEGMENT_BOUNDS.newMaxVisits.max,
    ),
    atRiskDays: clampInt(
      obj["at_risk_days"] ?? obj["atRiskDays"],
      CLIENT_SEGMENT_DEFAULTS.atRiskDays,
      CLIENT_SEGMENT_BOUNDS.atRiskDays.min,
      CLIENT_SEGMENT_BOUNDS.atRiskDays.max,
    ),
  };
}

/** Shape persisted to the salons jsonb column (snake_case keys). */
export function toClientSegmentJson(s: ClientSegmentSettings): {
  new_max_visits: number;
  at_risk_days: number;
} {
  return { new_max_visits: s.newMaxVisits, at_risk_days: s.atRiskDays };
}
