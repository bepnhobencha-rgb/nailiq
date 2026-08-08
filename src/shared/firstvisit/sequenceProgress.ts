export type FirstVisitFollowUpStep = 1 | 2;

/** Step 0 is delivered immediately during enrolment; the first due step is 1. */
export function firstVisitInitialFollowUpStep(): FirstVisitFollowUpStep {
  return 1;
}

/**
 * Legacy rows were stored as step 0 even though warmth had already been sent.
 * Treat them as step 1 so the customer never receives the warmth step twice.
 */
export function normalizeFirstVisitFollowUpStep(
  value: unknown,
): FirstVisitFollowUpStep {
  return Number(value) >= 2 ? 2 : 1;
}
