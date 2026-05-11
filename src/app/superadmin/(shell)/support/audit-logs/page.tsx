import { ComingSoonPage } from "@/components/superadmin/ComingSoonPage";

export default function AuditLogsPage() {
  return (
    <ComingSoonPage
      section="Support"
      title="Audit Log Viewer"
      phase="Phase 1E"
      description="Browse superadmin_audit_logs by actor, target, action, time window. Read-only; entries are append-only."
    />
  );
}
