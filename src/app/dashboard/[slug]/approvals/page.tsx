import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import {
  getAllApprovals,
  toApprovalDisplayRows,
} from "@/shared/ai/approvalRequests";
import { getOwnerExecutionJobs } from "@/shared/ai/executionQueue";
import { ApprovalsDashboard } from "@/components/dashboard/ApprovalsDashboard";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Việc chờ duyệt · ${slug}` };
}

export default async function ApprovalsPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  if (!isOwnerOrAdmin(ctx.role)) redirect(`/dashboard/${encodeURIComponent(slug)}`);

  const [approvalsResult, executionJobsResult] = await Promise.allSettled([
    getAllApprovals(ctx.salon.id),
    getOwnerExecutionJobs(ctx.salon.id, 100),
  ]);
  const approvalsAvailable = approvalsResult.status === "fulfilled";
  const executionJobsAvailable = executionJobsResult.status === "fulfilled";
  if (!approvalsAvailable) {
    console.error(
      "[ApprovalsPage] approvals unavailable",
      approvalsResult.reason,
    );
  }
  if (!executionJobsAvailable) {
    console.error(
      "[ApprovalsPage] execution_queue unavailable",
      executionJobsResult.reason,
    );
  }
  const approvals = approvalsAvailable ? approvalsResult.value : [];
  const executionJobs = executionJobsAvailable
    ? executionJobsResult.value
    : [];
  const displayApprovals = await toApprovalDisplayRows(approvals);

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <ApprovalsDashboard
        approvals={displayApprovals}
        executionJobs={executionJobs}
        approvalsAvailable={approvalsAvailable}
        executionJobsAvailable={executionJobsAvailable}
        slug={slug}
      />
    </div>
  );
}
