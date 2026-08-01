export const AI_CONTROL_REFRESH_INTERVAL_MS = 60_000;
export const AI_CONTROL_STALE_AFTER_MS = 45_000;

export function shouldRefreshAiControlCenter(input: {
  nowMs: number;
  observedAtMs: number;
  visibilityState: DocumentVisibilityState;
}): boolean {
  return (
    input.visibilityState === "visible" &&
    Number.isFinite(input.observedAtMs) &&
    input.nowMs - input.observedAtMs >= AI_CONTROL_STALE_AFTER_MS
  );
}
