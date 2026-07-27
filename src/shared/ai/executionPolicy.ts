export type ExecutionJobStatus =
  | "queued"
  | "waiting_input"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export function initialExecutionStatus(
  payload: Record<string, unknown>,
): ExecutionJobStatus {
  return payload.recipient_selection_required === true
    ? "waiting_input"
    : "queued";
}

export function canRetryExecution(params: {
  status: ExecutionJobStatus;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  now: Date;
}): boolean {
  if (params.status !== "failed" && params.status !== "queued") return false;
  if (params.attemptCount >= params.maxAttempts) return false;
  return Date.parse(params.availableAt) <= params.now.getTime();
}

export function nextRetryAt(attemptCount: number, now: Date): string {
  const normalizedAttempt = Math.max(1, Math.min(5, Math.floor(attemptCount)));
  const delayMinutes = Math.min(60, 2 ** (normalizedAttempt - 1) * 5);
  return new Date(now.getTime() + delayMinutes * 60_000).toISOString();
}
