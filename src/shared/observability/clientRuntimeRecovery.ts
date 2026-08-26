const HISTORY_REPLACE_STATE_RATE_LIMIT =
  /Attempt to use history\.replaceState\(\) more than 100 times per 10 seconds/i;

export type HistoryRateLimitRecoveryDecision = "reload" | "guarded" | null;

/** Safari raises this after a runaway App Router commit loop. */
export function isHistoryReplaceStateRateLimitError(message: string): boolean {
  return HISTORY_REPLACE_STATE_RATE_LIMIT.test(message.trim());
}

/**
 * Reload at most once inside the guard window. The caller persists the marker
 * before navigating so a fault that survives reload cannot create a reload
 * loop of its own.
 */
export function decideHistoryRateLimitRecovery(
  message: string,
  lastReloadAt: string | null,
  now: number,
  guardMs = 30_000,
): HistoryRateLimitRecoveryDecision {
  if (!isHistoryReplaceStateRateLimitError(message)) return null;

  const parsed = Number(lastReloadAt ?? "0");
  const last = Number.isFinite(parsed) ? parsed : 0;
  return last > 0 && now - last < guardMs ? "guarded" : "reload";
}
