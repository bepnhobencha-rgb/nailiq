export type OperationalExceptionStatus = "open" | "acknowledged" | "resolved";
export type OperationalExceptionSeverity = "info" | "warning" | "critical";
export type OperationalExceptionOperation = "acknowledge" | "resolve" | "reopen";

export type OperationalExceptionRow = {
  id: string;
  kind: string;
  severity: OperationalExceptionSeverity;
  title: string;
  body: string | null;
  status: OperationalExceptionStatus;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  source_type: string;
  source_ref: string;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
};
