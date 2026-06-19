import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { getAllApprovals } from "@/shared/ai/approvalRequests";
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

  const approvals = await getAllApprovals(ctx.salon.id);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca";

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <ApprovalsDashboard
        slug={slug}
        approvals={approvals}
        appUrl={appUrl}
      />
    </div>
  );
}
