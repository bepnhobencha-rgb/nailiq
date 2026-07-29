import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { AiControlCenter } from "@/components/dashboard/AiControlCenter";
import { getAllApprovals } from "@/shared/ai/approvalRequests";
import {
  loadMinhActivity,
  type MinhActivityData,
} from "@/shared/ai/loadMinhActivity";
import {
  resolveAiControlSource,
  type AiControlDataSource,
} from "@/shared/ai/controlCenterData";
import { getExecutionJobs } from "@/shared/ai/executionQueue";
import { loadAiOperatingState } from "@/shared/ai/operatingState";
import { getOperationalExceptions } from "@/shared/ai/operationalExceptions";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { requireReleaseFeatureEnabled } from "@/shared/features/requireReleaseFeature";

type Props = { params: Promise<{ slug: string }> };

const EMPTY_ACTIVITY: MinhActivityData = {
  entries: [],
  totalSent: 0,
  measured: 0,
  measurementCoveragePct: 0,
  converted: 0,
  pending: 0,
  noConversion: 0,
  agentStats: [],
};

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
    approvalsResult,
    activityResult,
    executionJobsResult,
    operatingStateResult,
    operationalExceptionResult,
  ] = await Promise.allSettled([
    getAllApprovals(ctx.salon.id),
    loadMinhActivity(ctx.salon.id, 30),
    getExecutionJobs(ctx.salon.id, 10),
    loadAiOperatingState(ctx.salon.id, now),
    getOperationalExceptions(ctx.salon.id, 50),
  ]);
  const sources = [
    resolveAiControlSource("approvals", approvalsResult, []),
    resolveAiControlSource("activity", activityResult, EMPTY_ACTIVITY),
    resolveAiControlSource("execution_queue", executionJobsResult, []),
    resolveAiControlSource("operating_state", operatingStateResult, null),
    resolveAiControlSource(
      "operational_exceptions",
      operationalExceptionResult,
      { items: [], activeCount: 0 },
    ),
  ] as const;
  const unavailableSources: AiControlDataSource[] = [];
  for (const source of sources) {
    if (source.unavailableSource) {
      unavailableSources.push(source.unavailableSource);
      console.error(
        `[AiControlCenterPage] ${source.unavailableSource} unavailable`,
        source.error,
      );
    }
  }
  const [
    approvalsSource,
    activitySource,
    executionJobsSource,
    operatingStateSource,
    operationalExceptionSource,
  ] = sources;
  const approvals = approvalsSource.value;
  const activity = activitySource.value;
  const executionJobs = executionJobsSource.value;
  const operatingState = operatingStateSource.value;
  const operationalExceptionInbox = operationalExceptionSource.value;

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
      unavailableSources={unavailableSources}
      appUrl={appUrl}
      nowIso={now.toISOString()}
    />
  );
}
