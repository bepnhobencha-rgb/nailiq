export type AiControlDataSource =
  | "approvals"
  | "activity"
  | "execution_queue"
  | "operating_state"
  | "operational_exceptions";

export type ResolvedAiControlSource<T, F> =
  | {
      value: T | F;
      unavailableSource: null;
      error: null;
    }
  | {
      value: T | F;
      unavailableSource: AiControlDataSource;
      error: unknown;
    };

export function resolveAiControlSource<T, F>(
  source: AiControlDataSource,
  result: PromiseSettledResult<T>,
  fallback: F,
): ResolvedAiControlSource<T, F> {
  if (result.status === "fulfilled") {
    return {
      value: result.value,
      unavailableSource: null,
      error: null,
    };
  }
  return {
    value: fallback,
    unavailableSource: source,
    error: result.reason,
  };
}
