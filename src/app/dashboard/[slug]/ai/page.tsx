import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { AiControlCenter } from "@/components/dashboard/AiControlCenter";
import {
  getApprovalInboxSnapshot,
  toApprovalDisplayRows,
  type ApprovalInboxSnapshot,
} from "@/shared/ai/approvalRequests";
import {
  loadMinhActivity,
  type MinhActivityData,
} from "@/shared/ai/loadMinhActivity";
import {
  resolveAiControlSource,
  type AiControlDataSource,
} from "@/shared/ai/controlCenterData";
import {
  getApprovalExecutionTraces,
  getOwnerExecutionJobs,
  type ApprovalExecutionTraceRow,
} from "@/shared/ai/executionQueue";
import { loadAiOperatingState } from "@/shared/ai/operatingState";
import { getOperationalExceptions } from "@/shared/ai/operationalExceptions";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { requireReleaseFeatureEnabled } from "@/shared/features/requireReleaseFeature";

type Props = { params: Promise<{ slug: string }> };

const EMPTY_ACTIVITY: MinhActivityData = {
  entries: [],
  totalActions: 0,
  totalSent: 0,
  measured: 0,
  measurementCoveragePct: 0,
  converted: 0,
  pending: 0,
  noConversion: 0,
  agentStats: [],
};
const EMPTY_APPROVAL_INBOX: ApprovalInboxSnapshot = {
  items: [],
  pendingCount: 0,
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
    getApprovalInboxSnapshot(ctx.salon.id),
    loadMinhActivity(ctx.salon.id, 30),
    getOwnerExecutionJobs(ctx.salon.id, 10),
    loadAiOperatingState(ctx.salon.id, now),
    getOperationalExceptions(ctx.salon.id, 50),
  ]);
  const sources = [
    resolveAiControlSource(
      "approvals",
      approvalsResult,
      EMPTY_APPROVAL_INBOX,
    ),
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
  const approvalInbox = approvalsSource.value;
  const activity = activitySource.value;
  const executionJobs = executionJobsSource.value;
  const operatingState = operatingStateSource.value;
  const operationalExceptionInbox = operationalExceptionSource.value;
  const approvalDisplayRows = await toApprovalDisplayRows(
    approvalInbox.items,
  );
  const recentDecisionIds = approvalInbox.items
    .filter((approval) => approval.status !== "pending")
    .slice(0, 3)
    .map((approval) => approval.id);
  let decisionExecutionTraces: ApprovalExecutionTraceRow[] = [];
  if (approvalsSource.unavailableSource === null) {
    try {
      decisionExecutionTraces = await getApprovalExecutionTraces(
        ctx.salon.id,
        recentDecisionIds,
      );
    } catch (error) {
      unavailableSources.push("decision_execution_trace");
      console.error(
        "[AiControlCenterPage] decision_execution_trace unavailable",
        error,
      );
    }
  }

  return (
    <AiControlCenter
      slug={slug}
      approvals={approvalDisplayRows}
      pendingApprovalCount={approvalInbox.pendingCount}
      activity={activity}
      executionJobs={executionJobs}
      decisionExecutionTraces={decisionExecutionTraces}
      operationalExceptions={operationalExceptionInbox.items}
      operationalExceptionCount={operationalExceptionInbox.activeCount}
      operatingState={operatingState}
      unavailableSources={unavailableSources}
      nowIso={now.toISOString()}
    />
  );
}
