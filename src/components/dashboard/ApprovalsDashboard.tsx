"use client";

import { CheckCircle, XCircle, Clock, AlertTriangle } from "lucide-react";

import { ApprovalDecisionButtons } from "@/components/dashboard/ApprovalDecisionButtons";
import { approvalExecutionPresentation } from "@/shared/ai/approvalExecutionPresentation";
import type { ApprovalDisplayRow } from "@/shared/ai/approvalRequests";
import type { ExecutionJobRow } from "@/shared/ai/executionQueue";
import { executionFailureLabel } from "@/shared/ai/executionFailure";

function timeLabel(iso: string): string {
  try {
    const ms = Date.parse(iso);
    const now = Date.now();
    const diff = ms - now;
    if (diff < 0) return "đã hết hạn";
    const m = Math.floor(diff / 60_000);
    if (m < 60) return `còn ${m} phút`;
    const h = Math.floor(m / 60);
    if (h < 24) return `còn ${h} giờ`;
    return `còn ${Math.floor(h / 24)} ngày`;
  } catch {
    return "";
  }
}

function createdLabel(iso: string): string {
  try {
    const ms = Date.parse(iso);
    const diff = Date.now() - ms;
    const m = Math.floor(diff / 60_000);
    if (m < 1) return "vừa xong";
    if (m < 60) return `${m} phút trước`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} giờ trước`;
    const d = Math.floor(h / 24);
    return `${d} ngày trước`;
  } catch {
    return "";
  }
}

function UrgencyBadge({ urgency }: { urgency: "urgent" | "normal" }) {
  if (urgency === "urgent") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
        <AlertTriangle className="h-3 w-3" />
        Gấp
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
      Bình thường
    </span>
  );
}

function StatusBadge({ status }: { status: ApprovalDisplayRow["status"] }) {
  if (status === "approved") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700 dark:bg-green-900/30 dark:text-green-400">
        <CheckCircle className="h-3 w-3" />
        Đã đồng ý
      </span>
    );
  }
  if (status === "declined") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
        <XCircle className="h-3 w-3" />
        Đã từ chối
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-400">
        <Clock className="h-3 w-3" />
        Hết hạn
      </span>
    );
  }
  // pending
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
      <Clock className="h-3 w-3" />
      Chờ duyệt
    </span>
  );
}

function PendingCard({
  req,
  slug,
}: {
  req: ApprovalDisplayRow;
  slug: string;
}) {
  return (
    <div className="rounded-xl border border-nq-border/60 bg-nq-surface p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <UrgencyBadge urgency={req.urgency} />
        <StatusBadge status={req.status} />
        <span className="ml-auto text-[12px] text-nq-muted">
          {timeLabel(req.expires_at)} · {createdLabel(req.created_at)}
        </span>
      </div>

      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-nq-muted">
        {req.action_type.replace(/_/g, " ")}
      </p>
      <p className="mb-4 text-[15px] leading-relaxed text-nq-foreground">
        {req.summary}
      </p>

      <ApprovalDecisionButtons slug={slug} approvalId={req.id} />
    </div>
  );
}

const EXECUTION_TONE = {
  neutral: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  attention:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  active: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  success:
    "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  error: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
} as const;

function ExecutionBadge({ job }: { job: ExecutionJobRow }) {
  const presentation = approvalExecutionPresentation(
    job.status,
    job.result?.blocker,
  );
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${EXECUTION_TONE[presentation.tone]}`}
    >
      <Clock className="h-3 w-3" aria-hidden />
      {presentation.label}
    </span>
  );
}

function DecidedRow({
  req,
  job,
}: {
  req: ApprovalDisplayRow;
  job: ExecutionJobRow | undefined;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-nq-border/40 py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={req.status} />
        {job ? <ExecutionBadge job={job} /> : null}
        <span className="text-[12px] font-medium text-nq-foreground line-clamp-1 flex-1">
          {req.summary}
        </span>
        <span className="text-[11px] text-nq-muted shrink-0">
          {req.decided_at
            ? createdLabel(req.decided_at)
            : createdLabel(req.created_at)}
        </span>
      </div>
      <p className="text-[11px] text-nq-muted">
        {req.action_type.replace(/_/g, " ")}
        {job && job.attempt_count > 0
          ? ` · Lần thử ${job.attempt_count}/${job.max_attempts}`
          : ""}
      </p>
      {job?.last_error ? (
        <p className="line-clamp-2 text-[11px] text-nq-error">
          {executionFailureLabel(job.last_error, "vi")}
        </p>
      ) : null}
    </div>
  );
}

export function ApprovalsDashboard({
  approvals,
  executionJobs,
  slug,
}: {
  approvals: ApprovalDisplayRow[];
  executionJobs: ExecutionJobRow[];
  slug: string;
}) {
  const pending = approvals.filter((r) => r.status === "pending");
  const decided = approvals.filter((r) => r.status !== "pending");
  const jobsByApproval = new Map(
    executionJobs.map((job) => [job.approval_request_id, job]),
  );

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-nq-foreground">Việc chờ duyệt</h1>
        <p className="mt-1 text-[14px] text-nq-muted">
          Các hành động AI đề xuất, quyết định của bạn và trạng thái thực thi thật.
        </p>
      </div>

      {/* Pending */}
      <section>
        <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-nq-muted">
          Đang chờ ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-nq-border py-10 text-center">
            <CheckCircle className="h-8 w-8 text-green-500" />
            <p className="text-[15px] font-medium text-nq-foreground">
              Không có yêu cầu nào đang chờ duyệt ✓
            </p>
            <p className="text-[13px] text-nq-muted">
              Minh sẽ thông báo khi có hành động cần xác nhận.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {pending.map((req) => (
              <PendingCard key={req.id} req={req} slug={slug} />
            ))}
          </div>
        )}
      </section>

      {/* Recent decisions */}
      {decided.length > 0 && (
        <section>
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-nq-muted">
            Đã xử lý gần đây
          </h2>
          <div className="rounded-xl border border-nq-border/60 bg-nq-surface px-5 py-1">
            {decided.map((req) => (
              <DecidedRow
                key={req.id}
                req={req}
                job={jobsByApproval.get(req.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
