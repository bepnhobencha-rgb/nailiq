import { ComingSoonPage } from "@/components/superadmin/ComingSoonPage";

export default function BillingSubscriptionsPage() {
  return (
    <ComingSoonPage
      section="Billing"
      title="Subscriptions"
      phase="Phase 2"
      description="Per-salon Stripe subscription state: plan, status, current period, trial end, cancellation."
    />
  );
}
