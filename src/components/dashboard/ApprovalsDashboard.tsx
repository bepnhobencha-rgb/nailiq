"use client";

import Link from "next/link";
import { CheckCircle, XCircle, Clock, AlertTriangle } from "lucide-react";

type ApprovalRow = {
  id: string;
  salon_id: string;
  action_type: string;
  summary: string;
  payload: Record<string, unknown>;
  urgency: "urgent" | "normal";
  status: "pending" | "approved" | "declined" | "expired";
  approve_token: string;
  decline_token: string;
  expires_at: string;
  notified_at: string | null;
  reminded_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
};

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

function StatusBadge({ status }: { status: ApprovalRow["status"] }) {
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
  appUrl,
  slug,
}: {
  req: ApprovalRow;
  appUrl: string;
  slug: string;
}) {
  const approveUrl = `${appUrl}/api/ai/approve?token=${req.approve_token}`;
  const declineUrl = `${appUrl}/api/ai/approve?token=${req.decline_token}`;

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

      <div className="flex flex-wrap gap-3">
        <Link
          href={approveUrl}
          className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-[14px] font-semibold text-white hover:bg-green-700 active:scale-95 transition-transform"
        >
          <CheckCircle className="h-4 w-4" />
          Đồng ý — thực hiện ngay
        </Link>
        <Link
          href={declineUrl}
          className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-[14px] font-semibold text-white hover:bg-red-700 active:scale-95 transition-transform"
        >
          <XCircle className="h-4 w-4" />
          Từ chối — bỏ qua
        </Link>
      </div>
    </div>
  );
}

function DecidedRow({ req }: { req: ApprovalRow }) {
  return (
    <div className="flex flex-col gap-1 border-b border-nq-border/40 py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={req.status} />
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
      </p>
    </div>
  );
}

export function ApprovalsDashboard({
  slug,
  approvals,
  appUrl,
}: {
  slug: string;
  approvals: ApprovalRow[];
  appUrl: string;
}) {
  const pending = approvals.filter((r) => r.status === "pending");
  const decided = approvals.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-nq-foreground">Việc chờ duyệt</h1>
        <p className="mt-1 text-[14px] text-nq-muted">
          Các hành động Minh muốn thực hiện và cần sự đồng ý của bạn.
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
              <PendingCard key={req.id} req={req} appUrl={appUrl} slug={slug} />
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
              <DecidedRow key={req.id} req={req} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
