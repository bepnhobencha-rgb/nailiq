export const SELF_SERVICE_TRIAL_DAYS = 14;

export function createTrialWindow(now = new Date()): {
  trialStartedAt: string;
  trialEndsAt: string;
} {
  const trialEnds = new Date(
    now.getTime() + SELF_SERVICE_TRIAL_DAYS * 24 * 60 * 60 * 1000,
  );
  return {
    trialStartedAt: now.toISOString(),
    trialEndsAt: trialEnds.toISOString(),
  };
}

export function trialDaysRemaining(
  trialEndsAt: string | null | undefined,
  now = new Date(),
): number | null {
  if (!trialEndsAt) return null;
  const endMs = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(endMs)) return null;
  return Math.max(
    0,
    Math.ceil((endMs - now.getTime()) / (24 * 60 * 60 * 1000)),
  );
}

