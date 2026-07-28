export type ObservedOutcome = "converted" | "no_conversion" | null;

export type OutcomeMeasurement = {
  sent: number;
  measured: number;
  pending: number;
  converted: number;
  noConversion: number;
  observedReturnPct: number | null;
  coveragePct: number;
};

/**
 * Reports only observed outcomes. Pending actions are excluded from the return
 * rate denominator because their attribution window has not finished yet.
 * This is an observational metric, not a claim that AI caused the booking.
 */
export function deriveOutcomeMeasurement(
  outcomes: ObservedOutcome[],
): OutcomeMeasurement {
  const sent = outcomes.length;
  const converted = outcomes.filter(
    (outcome) => outcome === "converted",
  ).length;
  const noConversion = outcomes.filter(
    (outcome) => outcome === "no_conversion",
  ).length;
  const measured = converted + noConversion;
  const pending = sent - measured;
  return {
    sent,
    measured,
    pending,
    converted,
    noConversion,
    observedReturnPct:
      measured > 0 ? Math.round((converted / measured) * 100) : null,
    coveragePct: sent > 0 ? Math.round((measured / sent) * 100) : 0,
  };
}
