export type OperationalExceptionStatus = "open" | "acknowledged" | "resolved";
export type OperationalExceptionSeverity = "info" | "warning" | "critical";
export type OperationalExceptionOperation = "acknowledge" | "resolve" | "reopen";

const SOURCE_OWNED_EXCEPTION_TYPES = new Set([
  "ai_execution",
  "ai_manager",
  "readiness",
]);

export function isSourceOwnedOperationalException(sourceType: string): boolean {
  return SOURCE_OWNED_EXCEPTION_TYPES.has(sourceType);
}

export type OperationalExceptionRow = {
  id: string;
  severity: OperationalExceptionSeverity;
  title: string;
  body: string | null;
  status: OperationalExceptionStatus;
  created_at: string;
  resolution_note: string | null;
  source_type: string;
  occurrence_count: number;
  last_seen_at: string;
};
