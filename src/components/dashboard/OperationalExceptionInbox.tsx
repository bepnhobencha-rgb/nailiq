"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AlertTriangle, CheckCheck, Eye, RotateCcw } from "lucide-react";

import { controlOperationalExceptionAction } from "@/shared/ai/controlOperationalExceptionAction";
import type {
  OperationalExceptionOperation,
  OperationalExceptionRow,
} from "@/shared/ai/operationalExceptionTypes";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  exceptions: OperationalExceptionRow[];
  activeCount: number;
  nowIso: string;
};

function relativeTime(iso: string, nowIso: string, vi: boolean): string {
  const minutes = Math.max(
    0,
    Math.floor((Date.parse(nowIso) - Date.parse(iso)) / 60_000),
  );
  if (minutes < 60) return vi ? `${minutes} phút trước` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return vi ? `${hours} giờ trước` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return vi ? `${days} ngày trước` : `${days}d ago`;
}

export function OperationalExceptionInbox({
  slug,
  exceptions,
  activeCount,
  nowIso,
}: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = exceptions.filter((item) => item.status !== "resolved");
  const recentlyResolved = exceptions
    .filter((item) => item.status === "resolved")
    .slice(0, 2);
  const visible = [...active.slice(0, 6), ...recentlyResolved];

  function control(
    item: OperationalExceptionRow,
    operation: OperationalExceptionOperation,
  ) {
    const resolutionNote =
      operation === "resolve"
        ? window.prompt(
            vi
              ? "Ghi chú cách đã xử lý (không bắt buộc, tối đa 500 ký tự)"
              : "Resolution note (optional, maximum 500 characters)",
          )
        : undefined;
    if (operation === "resolve" && resolutionNote === null) return;

    setBusyId(item.id);
    setError(null);
    startTransition(async () => {
      const result = await controlOperationalExceptionAction({
        slug,
        alertId: item.id,
        operation,
        resolutionNote: resolutionNote || undefined,
      });
      if (!result.ok) {
        setError(
          vi
            ? "Không thể cập nhật ngoại lệ. Hãy tải lại và thử lần nữa."
            : "The exception could not be updated. Refresh and try again.",
        );
      } else {
        router.refresh();
      }
      setBusyId(null);
    });
  }

  return (
    <section
      className="rounded-2xl border border-nq-border bg-nq-surface p-4 sm:p-5"
      aria-labelledby="operational-exceptions-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="operational-exceptions-heading"
            className="flex items-center gap-2 text-lg font-semibold text-nq-foreground"
          >
            <AlertTriangle className="h-5 w-5 text-nq-warning" aria-hidden />
            {vi ? "Ngoại lệ vận hành" : "Operational exceptions"}
          </h2>
          <p className="mt-1 text-xs leading-5 text-nq-muted">
            {vi
              ? "AI phát hiện vấn đề; bạn xác nhận đã xem và đóng khi thực sự xử lý xong."
              : "AI detects issues; acknowledge them and resolve only after the work is actually complete."}
          </p>
        </div>
        <span className="rounded-full bg-nq-warning/15 px-3 py-1 text-xs font-semibold text-nq-warning">
          {activeCount} {vi ? "đang mở" : "active"}
        </span>
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-xs text-nq-error">
          {error}
        </p>
      ) : null}

      {visible.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-nq-border p-5 text-center text-sm text-nq-muted">
          {vi
            ? "Chưa phát hiện ngoại lệ vận hành."
            : "No operational exceptions have been detected."}
        </div>
      ) : (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {visible.map((item) => {
            const working = pending && busyId === item.id;
            return (
              <article
                key={item.id}
                data-status={item.status}
                className="rounded-xl border border-nq-border/70 bg-nq-bg/40 p-3.5"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                      item.severity === "critical"
                        ? "bg-nq-error"
                        : item.severity === "warning"
                          ? "bg-nq-warning"
                          : "bg-nq-primary"
                    }`}
                    aria-label={item.severity}
                  />
                  <p className="min-w-0 flex-1 truncate text-sm font-semibold text-nq-foreground">
                    {item.title}
                  </p>
                  <span className="shrink-0 text-[11px] text-nq-muted">
                    {relativeTime(item.created_at, nowIso, vi)}
                  </span>
                </div>
                {item.body ? (
                  <p className="mt-2 line-clamp-3 text-xs leading-5 text-nq-muted">
                    {item.body}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <StatusBadge status={item.status} vi={vi} />
                  {item.status === "open" ? (
                    <ControlButton
                      disabled={working}
                      onClick={() => control(item, "acknowledge")}
                      icon={Eye}
                      label={vi ? "Đã xem" : "Acknowledge"}
                    />
                  ) : null}
                  {item.status !== "resolved" ? (
                    <ControlButton
                      disabled={working}
                      onClick={() => control(item, "resolve")}
                      icon={CheckCheck}
                      label={vi ? "Đã xử lý" : "Resolve"}
                    />
                  ) : (
                    <ControlButton
                      disabled={working}
                      onClick={() => control(item, "reopen")}
                      icon={RotateCcw}
                      label={vi ? "Mở lại" : "Reopen"}
                    />
                  )}
                </div>
                {item.status === "resolved" && item.resolution_note ? (
                  <p className="mt-2 text-[11px] leading-4 text-nq-muted">
                    {vi ? "Ghi chú: " : "Resolution: "}
                    {item.resolution_note}
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function StatusBadge({
  status,
  vi,
}: {
  status: OperationalExceptionRow["status"];
  vi: boolean;
}) {
  const copy = {
    open: vi ? "Mới" : "Open",
    acknowledged: vi ? "Đã xem" : "Acknowledged",
    resolved: vi ? "Đã xử lý" : "Resolved",
  }[status];
  return (
    <span className="mr-auto rounded-full border border-nq-border px-2 py-0.5 text-[11px] font-medium text-nq-muted">
      {copy}
    </span>
  );
}

function ControlButton({
  disabled,
  onClick,
  icon: Icon,
  label,
}: {
  disabled: boolean;
  onClick: () => void;
  icon: typeof Eye;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-nq-border px-2.5 text-xs font-medium text-nq-foreground hover:border-nq-primary/50 disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </button>
  );
}
