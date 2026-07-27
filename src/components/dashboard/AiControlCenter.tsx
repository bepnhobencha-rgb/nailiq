"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  Clock3,
  Gauge,
  Lightbulb,
  ListChecks,
  ShieldCheck,
  Sparkles,
  Target,
  Undo2,
  Users,
  X,
} from "lucide-react";

import { buildActionIntelligence } from "@/shared/ai/actionIntelligence";
import type { ApprovalRow } from "@/shared/ai/approvalRequests";
import { prepareAudienceAction } from "@/shared/ai/prepareAudienceAction";
import type { ExecutionJobRow } from "@/shared/ai/executionQueue";
import type { MinhActivityData } from "@/shared/ai/loadMinhActivity";
import type {
  AiOperatingState,
  LearnedAiControl,
} from "@/shared/ai/operatingState";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  approvals: ApprovalRow[];
  activity: MinhActivityData;
  executionJobs: ExecutionJobRow[];
  operatingState: AiOperatingState;
  appUrl: string;
  nowIso: string;
};

function relativeTime(iso: string, nowIso: string, language: "en" | "vi"): string {
  const minutes = Math.max(0, Math.floor((Date.parse(nowIso) - Date.parse(iso)) / 60_000));
  if (minutes < 1) return language === "vi" ? "Vừa xong" : "Just now";
  if (minutes < 60) return language === "vi" ? `${minutes} phút trước` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return language === "vi" ? `${hours} giờ trước` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return language === "vi" ? `${days} ngày trước` : `${days}d ago`;
}

export function AiControlCenter({
  slug,
  approvals,
  activity,
  executionJobs,
  operatingState,
  appUrl,
  nowIso,
}: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const pending = approvals.filter((item) => item.status === "pending");
  const recentActivity = activity.entries.slice(0, 6);
  const effectiveness =
    activity.totalSent > 0
      ? Math.round((activity.converted / activity.totalSent) * 100)
      : null;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-nq-primary/25 bg-nq-primary/10 px-3 py-1 text-xs font-semibold text-nq-primary">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            {vi ? "Bộ não vận hành" : "Operating intelligence"}
          </div>
          <h1 className="text-2xl font-semibold text-nq-foreground sm:text-3xl">
            AI Control Center
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-nq-muted">
            {vi
              ? "Một nơi để hiểu AI đang đề xuất gì, đang làm gì và tạo ra kết quả nào cho tiệm."
              : "One place to understand what AI recommends, what it is doing, and the outcomes it creates."}
          </p>
        </div>
        <Link
          href={`/dashboard/${encodeURIComponent(slug)}/settings`}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-nq-border bg-nq-surface px-4 text-sm font-medium text-nq-foreground transition-colors hover:border-nq-primary/40"
        >
          <ShieldCheck className="h-4 w-4 text-nq-primary" aria-hidden />
          {vi ? "Quyền tự động hóa" : "Automation permissions"}
        </Link>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={vi ? "Tổng quan AI" : "AI overview"}>
        <Metric label={vi ? "Cần bạn quyết định" : "Needs your decision"} value={pending.length} tone={pending.length > 0 ? "attention" : "default"} />
        <Metric label={vi ? "Hành động 30 ngày" : "30-day actions"} value={activity.entries.length} />
        <Metric label={vi ? "Khách quay lại" : "Customers returned"} value={activity.converted} tone="success" />
        <Metric label={vi ? "Hiệu quả đo được" : "Measured effectiveness"} value={effectiveness == null ? "—" : `${effectiveness}%`} />
      </section>

      <OperatingStatus
        state={operatingState}
        language={language}
        nowIso={nowIso}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-nq-foreground">
                {vi ? "Cần bạn quyết định" : "Needs your decision"}
              </h2>
              <p className="text-xs text-nq-muted">
                {vi ? "AI không thực hiện các việc nhạy cảm khi chưa được phép." : "AI will not perform sensitive actions without permission."}
              </p>
            </div>
            <Link href={`/dashboard/${encodeURIComponent(slug)}/approvals`} className="text-xs font-semibold text-nq-primary hover:underline">
              {vi ? "Xem tất cả" : "View all"}
            </Link>
          </div>

          {pending.length === 0 ? (
            <div className="flex min-h-44 flex-col items-center justify-center rounded-2xl border border-dashed border-nq-border bg-nq-surface/35 p-6 text-center">
              <CheckCircle2 className="h-8 w-8 text-nq-success" aria-hidden />
              <p className="mt-3 text-sm font-medium text-nq-foreground">
                {vi ? "Không có quyết định đang chờ" : "No decisions are waiting"}
              </p>
              <p className="mt-1 text-xs text-nq-muted">
                {vi ? "AI sẽ đưa ngoại lệ về đây khi cần bạn kiểm soát." : "AI will bring exceptions here when your control is needed."}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {pending.slice(0, 4).map((request) => {
                const intelligence = buildActionIntelligence(
                  request.action_type,
                  request.payload,
                  language,
                );
                return (
                <article key={request.id} className="overflow-hidden rounded-2xl border border-nq-border bg-nq-surface">
                  <div className="p-4 sm:p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${request.urgency === "urgent" ? "bg-nq-error/15 text-nq-error" : "bg-nq-warning/15 text-nq-warning"}`}>
                      {request.urgency === "urgent" ? (vi ? "Gấp" : "Urgent") : (vi ? "Bình thường" : "Normal")}
                    </span>
                    <span className="text-[11px] uppercase tracking-wide text-nq-muted">
                      {request.action_type.replaceAll("_", " ")}
                    </span>
                    <span className="ml-auto text-xs text-nq-muted">{relativeTime(request.created_at, nowIso, language)}</span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-nq-foreground">{request.summary}</p>

                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    <IntelligenceItem
                      icon={Lightbulb}
                      label={vi ? "Vì sao AI đề xuất?" : "Why is AI recommending this?"}
                      value={intelligence.reason}
                    />
                    <IntelligenceItem
                      icon={Target}
                      label={vi ? "Tác động dự kiến" : "Expected impact"}
                      value={intelligence.impact}
                    />
                    <div className="rounded-xl border border-nq-border/60 bg-nq-bg/45 p-3">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                        <ListChecks className="h-3.5 w-3.5 text-nq-primary" aria-hidden />
                        {vi ? "Bằng chứng" : "Evidence"}
                      </div>
                      <ul className="mt-2 space-y-1.5">
                        {intelligence.evidence.map((item) => (
                          <li key={item} className="flex gap-2 text-xs leading-5 text-nq-foreground/85">
                            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-nq-primary" aria-hidden />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Signal
                        icon={Gauge}
                        label={vi ? "Độ tin cậy" : "Confidence"}
                        value={intelligence.confidence.label}
                        tone={
                          intelligence.confidence.percent != null &&
                          intelligence.confidence.percent >= 70
                            ? "success"
                            : "default"
                        }
                      />
                      <Signal
                        icon={Undo2}
                        label={vi ? "Hoàn tác" : "Undo"}
                        value={intelligence.reversibility.label}
                        tone={
                          intelligence.reversibility.reversible === false
                            ? "warning"
                            : "default"
                        }
                      />
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <Link href={`${appUrl}/api/ai/approve?token=${request.approve_token}`} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-nq-success px-3 text-sm font-semibold text-white">
                      <Check className="h-4 w-4" aria-hidden />
                      {vi ? "Đồng ý" : "Approve"}
                    </Link>
                    <Link href={`${appUrl}/api/ai/approve?token=${request.decline_token}`} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-nq-error/40 px-3 text-sm font-semibold text-nq-error">
                      <X className="h-4 w-4" aria-hidden />
                      {vi ? "Từ chối" : "Decline"}
                    </Link>
                  </div>
                  </div>
                  {intelligence.reversibility.reversible === false ? (
                    <p className="border-t border-nq-warning/25 bg-nq-warning/10 px-4 py-2.5 text-xs leading-5 text-nq-warning sm:px-5">
                      {vi
                        ? "Hãy kiểm tra kỹ: hành động này không thể được AI hoàn tác tự động sau khi thực hiện."
                        : "Review carefully: AI cannot automatically undo this action after execution."}
                    </p>
                  ) : null}
                </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold text-nq-foreground">
              {vi ? "AI đang làm gì" : "What AI is doing"}
            </h2>
            <p className="text-xs text-nq-muted">
              {vi ? "Dòng hoạt động gần nhất và kết quả quan sát được." : "Recent activity and observed outcomes."}
            </p>
          </div>
          <div className="rounded-2xl border border-nq-border bg-nq-surface px-4">
            {recentActivity.length === 0 ? (
              <div className="flex min-h-44 flex-col items-center justify-center text-center">
                <Bot className="h-8 w-8 text-nq-muted" aria-hidden />
                <p className="mt-3 text-sm text-nq-muted">{vi ? "Chưa có hoạt động AI." : "No AI activity yet."}</p>
              </div>
            ) : (
              <div className="divide-y divide-nq-border/50">
                {recentActivity.map((entry) => (
                  <div key={entry.id} className="flex gap-3 py-3.5">
                    <span className="text-lg" aria-hidden>{entry.agentIcon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-xs font-semibold text-nq-foreground">{entry.agentLabel}</p>
                        {entry.outcome === "converted" ? <CheckCircle2 className="h-3.5 w-3.5 text-nq-success" aria-label={vi ? "Có kết quả" : "Converted"} /> : null}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-nq-muted">
                        {entry.messagePreview || entry.actionType.replaceAll("_", " ")}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] text-nq-muted">{relativeTime(entry.createdAt, nowIso, language)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-2xl border border-nq-border bg-nq-surface p-4">
            <div className="flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-nq-primary" aria-hidden />
              <h3 className="text-sm font-semibold text-nq-foreground">
                {vi ? "Hàng đợi thực thi" : "Execution queue"}
              </h3>
            </div>
            {executionJobs.length === 0 ? (
              <p className="mt-3 text-xs leading-5 text-nq-muted">
                {vi
                  ? "Chưa có hành động đã duyệt nào được xếp hàng."
                  : "No approved actions have been queued yet."}
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {executionJobs.slice(0, 4).map((job) => (
                  <div
                    key={job.id}
                    className="rounded-xl border border-nq-border/60 bg-nq-bg/45 p-3"
                  >
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-xs font-medium text-nq-foreground">
                        {job.action_type.replaceAll("_", " ")}
                      </p>
                      <ExecutionStatus status={job.status} vi={vi} />
                    </div>
                    <p className="mt-1 text-[11px] text-nq-muted">
                      {relativeTime(job.created_at, nowIso, language)}
                      {job.attempt_count > 0
                        ? ` · ${vi ? "Lần thử" : "Attempt"} ${job.attempt_count}/${job.max_attempts}`
                        : ""}
                    </p>
                    {job.status === "waiting_input" ? (
                      <JobAudiencePreparation job={job} slug={slug} vi={vi} />
                    ) : null}
                    {job.last_error ? (
                      <p className="mt-2 line-clamp-2 text-xs leading-5 text-nq-error">
                        {job.last_error}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
          <Link href={`/dashboard/${encodeURIComponent(slug)}/manager`} className="flex min-h-11 items-center justify-between rounded-xl border border-nq-border px-4 text-sm font-medium text-nq-foreground hover:border-nq-primary/40">
            <span className="inline-flex items-center gap-2"><Activity className="h-4 w-4 text-nq-primary" aria-hidden />{vi ? "Nhật ký AI đầy đủ" : "Full AI activity"}</span>
            <ArrowRight className="h-4 w-4 text-nq-muted" aria-hidden />
          </Link>
        </aside>
      </div>
    </main>
  );
}

function OperatingStatus({
  state,
  language,
  nowIso,
}: {
  state: AiOperatingState;
  language: "en" | "vi";
  nowIso: string;
}) {
  const vi = language === "vi";
  const { health } = state;
  const copy = {
    healthy: {
      title: vi ? "AI đang vận hành ổn định" : "AI is operating normally",
      detail: vi
        ? "Không có công việc bị lỗi, mắc kẹt hoặc đang chờ bạn bổ sung thông tin."
        : "No work is failed, stalled, or waiting for information from you.",
    },
    active: {
      title: vi ? "AI đang xử lý công việc" : "AI is processing work",
      detail: vi
        ? `${health.activeWork} công việc đang xếp hàng hoặc thực thi.`
        : `${health.activeWork} ${health.activeWork === 1 ? "job is" : "jobs are"} queued or running.`,
    },
    attention: {
      title: vi ? "AI đang chờ thông tin" : "AI is waiting for information",
      detail: vi
        ? `${health.waitingInput} công việc đã được duyệt nhưng cần thêm dữ liệu an toàn trước khi chạy.`
        : `${health.waitingInput} approved ${health.waitingInput === 1 ? "job needs" : "jobs need"} safe execution input.`,
    },
    issue: {
      title: vi ? "Có công việc AI cần kiểm tra" : "AI work needs review",
      detail: vi
        ? `${health.failed} lỗi · ${health.stalled} worker quá hạn 15 phút. Hệ thống không che giấu lỗi hoặc tự coi là thành công.`
        : `${health.failed} failed · ${health.stalled} worker leases over 15 minutes. Failures are never hidden or reported as success.`,
    },
  }[health.tone];
  const tone =
    health.tone === "issue"
      ? "border-nq-error/35 bg-nq-error/5"
      : health.tone === "attention"
        ? "border-nq-warning/35 bg-nq-warning/5"
        : "border-nq-success/30 bg-nq-success/5";
  const iconTone =
    health.tone === "issue"
      ? "text-nq-error"
      : health.tone === "attention"
        ? "text-nq-warning"
        : "text-nq-success";

  return (
    <section
      className={`grid gap-4 rounded-2xl border p-4 sm:p-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] ${tone}`}
      aria-label={vi ? "Trạng thái vận hành AI" : "AI operating status"}
    >
      <div className="flex gap-3">
        <div className="mt-0.5 rounded-xl border border-current/15 bg-nq-surface p-2.5">
          <Activity className={`h-5 w-5 ${iconTone}`} aria-hidden />
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
            {vi ? "Sức khỏe vận hành" : "Operating health"}
          </p>
          <h2 className="mt-1 text-base font-semibold text-nq-foreground">
            {copy.title}
          </h2>
          <p className="mt-1 text-xs leading-5 text-nq-muted">{copy.detail}</p>
          <p className="mt-2 text-[11px] text-nq-muted">
            {vi ? "Quan sát" : "Observed"}{" "}
            {relativeTime(state.observedAt, nowIso, language)}
          </p>
        </div>
      </div>

      <div className="border-t border-nq-border/50 pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-nq-primary" aria-hidden />
          <h3 className="text-sm font-semibold text-nq-foreground">
            {vi ? "AI đã học và đang áp dụng" : "What AI learned and is applying"}
          </h3>
        </div>
        {state.learnedControls.length === 0 ? (
          <p className="mt-2 text-xs leading-5 text-nq-muted">
            {vi
              ? "Chưa có điều chỉnh tự động nào đang hoạt động. AI vẫn theo giới hạn bạn đã cấu hình."
              : "No learned adjustment is active. AI is following your configured limits."}
          </p>
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {state.learnedControls.slice(0, 4).map((control) => (
              <LearnedControl
                key={learnedControlKey(control)}
                control={control}
                language={language}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function learnedControlKey(control: LearnedAiControl): string {
  return control.kind === "proposal_cooldown"
    ? `${control.kind}:${control.actionType}:${control.proposalSource ?? "all"}`
    : `${control.kind}:${control.agent}`;
}

function LearnedControl({
  control,
  language,
}: {
  control: LearnedAiControl;
  language: "en" | "vi";
}) {
  const vi = language === "vi";
  if (control.kind === "proposal_cooldown") {
    const until = new Intl.DateTimeFormat(vi ? "vi-CA" : "en-CA", {
      month: "short",
      day: "numeric",
    }).format(new Date(control.suppressUntil));
    return (
      <div className="rounded-xl border border-nq-border/60 bg-nq-surface/75 p-3">
        <p className="text-xs font-semibold text-nq-foreground">
          {vi ? "Giảm đề xuất lặp lại" : "Fewer repeated proposals"}
        </p>
        <p className="mt-1 text-[11px] leading-4 text-nq-muted">
          {vi
            ? `Bạn thường từ chối ${control.actionType.replaceAll("_", " ")}; AI tạm ngưng đề xuất này đến ${until}.`
            : `You often declined ${control.actionType.replaceAll("_", " ")}; AI paused this proposal until ${until}.`}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-nq-border/60 bg-nq-surface/75 p-3">
      <p className="text-xs font-semibold text-nq-foreground">
        {vi ? "Giảm nhịp liên hệ" : "Reduced contact pace"}
      </p>
      <p className="mt-1 text-[11px] leading-4 text-nq-muted">
        {vi
          ? `${control.agent} đang chạy ở ${Math.round(control.capMultiplier * 100)}% giới hạn sau khi đo kết quả gần đây.`
          : `${control.agent} is running at ${Math.round(control.capMultiplier * 100)}% of its cap after recent outcome measurement.`}
      </p>
    </div>
  );
}

type AudiencePreparationView = {
  prepared_at: string;
  eligible_count: number;
  sms_recipient_count: number;
  email_recipient_count: number;
  excluded_no_consent: number;
  excluded_no_channel: number;
  excluded_recent_contact: number;
  estimated_cost_usd_cents: number;
  candidate_limit: number;
  may_have_more_candidates: boolean;
  no_messages_sent: true;
};

function audiencePreparationFrom(
  result: Record<string, unknown> | null,
): AudiencePreparationView | null {
  const value = result?.audience_preparation;
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.prepared_at !== "string" ||
    typeof row.eligible_count !== "number" ||
    row.no_messages_sent !== true
  ) {
    return null;
  }
  return row as unknown as AudiencePreparationView;
}

function JobAudiencePreparation({
  job,
  slug,
  vi,
}: {
  job: ExecutionJobRow;
  slug: string;
  vi: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const preparation = audiencePreparationFrom(job.result);

  const prepare = () => {
    setError(null);
    startTransition(async () => {
      const result = await prepareAudienceAction({ slug, jobId: job.id });
      if (!result.ok) {
        setError(
          vi
            ? "Không thể chuẩn bị danh sách lúc này."
            : "The audience could not be prepared right now.",
        );
        return;
      }
      router.refresh();
    });
  };

  if (!preparation) {
    return (
      <div className="mt-2">
        <p className="text-xs leading-5 text-nq-warning">
          {vi
            ? "Đang chờ chọn người nhận và kiểm tra consent. Chưa gửi tin nhắn."
            : "Waiting for recipient selection and consent checks. No message was sent."}
        </p>
        {job.action_type === "bulk_message" ? (
          <button
            type="button"
            disabled={pending}
            onClick={prepare}
            className="mt-2 inline-flex min-h-9 items-center gap-2 rounded-lg border border-nq-primary/35 px-3 text-xs font-semibold text-nq-primary transition-colors hover:bg-nq-primary/10 disabled:cursor-wait disabled:opacity-60"
          >
            <Users className="h-3.5 w-3.5" aria-hidden />
            {pending
              ? vi
                ? "Đang kiểm tra…"
                : "Checking…"
              : vi
                ? "Chuẩn bị danh sách"
                : "Prepare audience"}
          </button>
        ) : null}
        {error ? <p className="mt-2 text-xs text-nq-error">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-nq-border/60 bg-nq-surface/70 p-2.5">
      <p className="text-xs font-semibold text-nq-foreground">
        {vi
          ? `${preparation.eligible_count} khách đủ điều kiện`
          : `${preparation.eligible_count} eligible customers`}
      </p>
      <p className="mt-1 text-[11px] leading-4 text-nq-muted">
        SMS {preparation.sms_recipient_count} · Email{" "}
        {preparation.email_recipient_count} ·{" "}
        {vi ? "ước tính" : "estimated"} $
        {(preparation.estimated_cost_usd_cents / 100).toFixed(2)} USD
      </p>
      <p className="mt-1 text-[11px] leading-4 text-nq-muted">
        {vi ? "Đã loại" : "Excluded"}:{" "}
        {preparation.excluded_recent_contact}{" "}
        {vi ? "đã liên hệ trong 24h" : "contacted within 24h"},{" "}
        {preparation.excluded_no_consent} {vi ? "thiếu consent" : "without consent"},{" "}
        {preparation.excluded_no_channel} {vi ? "thiếu kênh hợp lệ" : "without a valid channel"}.
      </p>
      {preparation.may_have_more_candidates ? (
        <p className="mt-1 text-[11px] leading-4 text-nq-muted">
          {vi
            ? `Bản kiểm tra được giới hạn ở ${preparation.candidate_limit} ứng viên để vận hành an toàn.`
            : `This dry run is capped at ${preparation.candidate_limit} candidates for safe operation.`}
        </p>
      ) : null}
      <p className="mt-1 text-[11px] font-medium text-nq-warning">
        {vi
          ? "Đây chỉ là bản kiểm tra. Chưa có tin nhắn nào được gửi."
          : "This is a dry run only. No message was sent."}
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={prepare}
        className="mt-2 text-[11px] font-semibold text-nq-primary hover:underline disabled:opacity-60"
      >
        {pending
          ? vi
            ? "Đang kiểm tra lại…"
            : "Rechecking…"
          : vi
            ? "Kiểm tra lại audience"
            : "Recheck audience"}
      </button>
      {error ? <p className="mt-2 text-xs text-nq-error">{error}</p> : null}
    </div>
  );
}

function ExecutionStatus({
  status,
  vi,
}: {
  status: ExecutionJobRow["status"];
  vi: boolean;
}) {
  const labels: Record<ExecutionJobRow["status"], { en: string; vi: string }> = {
    queued: { en: "Queued", vi: "Đã xếp hàng" },
    waiting_input: { en: "Needs input", vi: "Cần thông tin" },
    running: { en: "Running", vi: "Đang chạy" },
    succeeded: { en: "Succeeded", vi: "Thành công" },
    failed: { en: "Failed", vi: "Thất bại" },
    canceled: { en: "Canceled", vi: "Đã hủy" },
  };
  const tone =
    status === "succeeded"
      ? "bg-nq-success/15 text-nq-success"
      : status === "failed"
        ? "bg-nq-error/15 text-nq-error"
        : status === "waiting_input"
          ? "bg-nq-warning/15 text-nq-warning"
          : "bg-nq-primary/10 text-nq-primary";
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone}`}>
      {vi ? labels[status].vi : labels[status].en}
    </span>
  );
}

function IntelligenceItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Lightbulb;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-nq-border/60 bg-nq-bg/45 p-3">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
        <Icon className="h-3.5 w-3.5 text-nq-primary" aria-hidden />
        {label}
      </div>
      <p className="mt-2 text-xs leading-5 text-nq-foreground/85">{value}</p>
    </div>
  );
}

function Signal({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Gauge;
  label: string;
  value: string;
  tone: "default" | "success" | "warning";
}) {
  const valueColor =
    tone === "success"
      ? "text-nq-success"
      : tone === "warning"
        ? "text-nq-warning"
        : "text-nq-foreground";
  return (
    <div className="rounded-xl border border-nq-border/60 bg-nq-bg/45 p-3">
      <div className="flex items-center gap-2 text-[11px] text-nq-muted">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
      </div>
      <p className={`mt-2 text-xs font-semibold leading-5 ${valueColor}`}>{value}</p>
    </div>
  );
}

function Metric({ label, value, tone = "default" }: { label: string; value: number | string; tone?: "default" | "attention" | "success" }) {
  const color = tone === "attention" ? "text-nq-error" : tone === "success" ? "text-nq-success" : "text-nq-foreground";
  const Icon = tone === "attention" ? Clock3 : tone === "success" ? CheckCircle2 : Bot;
  return (
    <div className="rounded-2xl border border-nq-border bg-nq-surface p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-nq-muted">{label}</p>
        <Icon className={`h-4 w-4 ${color}`} aria-hidden />
      </div>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
