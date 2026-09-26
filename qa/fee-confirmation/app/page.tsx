import { cookies } from "next/headers";
import { NoShowFeeApprovalQueue } from "@/components/dashboard/NoShowFeeApprovalQueue";
import { LateCancellationFeeApprovalQueue } from "@/components/dashboard/LateCancellationFeeApprovalQueue";
import { GroupCancellationFeeApprovalQueue } from "@/components/dashboard/GroupCancellationFeeApprovalQueue";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ pending?: string }> }) {
  const jar = await cookies();
  const pending = (await searchParams).pending === "1";
  const common = {
    reviewId: "qa-review", bookingId: "qa-booking", clientName: "Synthetic QA", serviceName: "QA service", startTimeUtc: "2026-09-25T12:00:00Z",
    amountCents: 100, currency: "CAD", cardBrand: "VISA", cardLast4: "1111", consentPolicyVersion: "synthetic-policy-1", requestedAt: "2026-09-25T12:00:00Z",
  };
  function status(kind: string) { return jar.get(`qa-status-${kind}`)?.value ?? "dispatch_blocked"; }
  function state(kind: string) { return pending && !jar.has(`qa-status-${kind}`) ? "pending_review" as const : "approved_charge" as const; }
  return <main className="p-4">
    <NoShowFeeApprovalQueue slug="no-show" salonId="qa-salon" items={[{ ...common, decisionId: "qa-decision", state: state("no-show") === "pending_review" ? "pending" : "approved_charge", paymentStatus: status("no-show"), aiRecommendation: "review", aiReasonCodes: [], }]} />
    <LateCancellationFeeApprovalQueue slug="late" salonId="qa-salon" items={[{ ...common, state: state("late"), paymentStatus: status("late"), feePercent: 20, graceEndedAt: null }]} />
    <GroupCancellationFeeApprovalQueue slug="group" salonId="qa-salon" items={[{ ...common, state: state("group"), paymentStatus: status("group"), groupId: "qa-group", organizerBookingId: "qa-organizer", groupSize: 2 }]} />
  </main>;
}
