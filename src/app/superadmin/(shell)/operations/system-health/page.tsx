import { ComingSoonPage } from "@/components/superadmin/ComingSoonPage";

export default function SystemHealthPage() {
  return (
    <ComingSoonPage
      section="Operations"
      title="System Health"
      phase="Phase 2"
      description="Live signals: error rate, p95 latency, Supabase quotas, Sentry budget, queue depth."
    />
  );
}
