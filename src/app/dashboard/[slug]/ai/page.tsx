import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { AiControlCenter } from "@/components/dashboard/AiControlCenter";
import { getAllApprovals } from "@/shared/ai/approvalRequests";
import { loadMinhActivity } from "@/shared/ai/loadMinhActivity";
import { getExecutionJobs } from "@/shared/ai/executionQueue";
import { loadAiOperatingState } from "@/shared/ai/operatingState";
import { getOperationalExceptions } from "@/shared/ai/operationalExceptions";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { requireReleaseFeatureEnabled } from "@/shared/features/requireReleaseFeature";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `AI Control Center · ${slug}` };
}

export default async function AiControlCenterPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  if (!isOwnerOrAdmin(ctx.role)) {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }
  const releaseGate = await requireReleaseFeatureEnabled(slug, "ai_control_center");
  if (!releaseGate.ok) notFound();

  const now = new Date();
  const [
    approvals,
    activity,
    executionJobs,
    operatingState,
    operationalExceptionInbox,
  ] = await Promise.all([
    getAllApprovals(ctx.salon.id),
    loadMinhActivity(ctx.salon.id, 30),
    getExecutionJobs(ctx.salon.id, 10),
    loadAiOperatingState(ctx.salon.id, now),
    getOperationalExceptions(ctx.salon.id, 50),
  ]);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca";

  return (
    <AiControlCenter
      slug={slug}
      approvals={approvals}
      activity={activity}
      executionJobs={executionJobs}
      operationalExceptions={operationalExceptionInbox.items}
      operationalExceptionCount={operationalExceptionInbox.activeCount}
      operatingState={operatingState}
      appUrl={appUrl}
      nowIso={now.toISOString()}
    />
  );
}
