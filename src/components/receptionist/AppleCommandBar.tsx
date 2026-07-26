"use client";

import {
  CalendarDays,
  CircleAlert,
  Clock3,
  Sparkles,
  UserRound,
} from "lucide-react";

type AppleCommandBarProps = {
  appointmentCount: number;
  waitingCount: number;
  lateCount: number;
  availableStaffName: string | null;
  waitingGuestName: string | null;
  canAct: boolean;
  language: "en" | "vi";
  onAction: () => void;
};

export function AppleCommandBar({
  appointmentCount,
  waitingCount,
  lateCount,
  availableStaffName,
  waitingGuestName,
  canAct,
  language,
  onAction,
}: AppleCommandBarProps) {
  const hasAssignment = Boolean(waitingGuestName && availableStaffName);
  const suggestion = hasAssignment
    ? language === "vi"
      ? `Xếp ${waitingGuestName} cho ${availableStaffName}`
      : `Assign ${waitingGuestName} to ${availableStaffName}`
    : availableStaffName
      ? language === "vi"
        ? `${availableStaffName} đang sẵn sàng`
        : `${availableStaffName} is available`
      : language === "vi"
        ? "Lịch hôm nay đã sẵn sàng"
        : "Today's schedule is ready";
  const actionLabel = hasAssignment
    ? language === "vi"
      ? "Xem"
      : "Review"
    : language === "vi"
      ? "+ Khách vãng lai"
      : "+ Walk-in";

  const stats = [
    {
      key: "appointments",
      icon: CalendarDays,
      value: appointmentCount,
      label: language === "vi" ? "lịch hẹn" : "appointments",
      valueClass: "text-nq-info",
      widthClass: "min-w-[264px]",
    },
    {
      key: "waiting",
      icon: Clock3,
      value: waitingCount,
      label: language === "vi" ? "đang chờ" : "waiting",
      valueClass: "text-[var(--rc-new-text)]",
      widthClass: "min-w-[250px]",
    },
    {
      key: "late",
      icon: CircleAlert,
      value: lateCount,
      label: language === "vi" ? "trễ" : "late",
      valueClass: lateCount > 0 ? "text-nq-warning" : "text-[var(--rc-new-muted)]",
      widthClass: "min-w-[170px]",
    },
  ] as const;

  return (
    <section
      data-testid="preview-command-bar"
      className="shrink-0 overflow-x-auto rounded-lg border border-[var(--rc-new-border)] bg-[var(--rc-new-surface)] shadow-sm"
      aria-label={language === "vi" ? "Tình hình hôm nay" : "Today's status"}
    >
      <div className="flex w-full min-w-[1268px] items-stretch">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.key}
              data-testid={`preview-command-${stat.key}`}
              className={`flex min-h-[68px] items-center gap-3 border-r border-[var(--rc-new-border)] px-5 ${stat.widthClass}`}
            >
              {stat.key === "appointments" ? (
                <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[var(--rc-new-border)] bg-[var(--rc-new-surface)]">
                  <Icon
                    className="h-5 w-5 text-[var(--rc-new-muted)]"
                    aria-hidden
                  />
                </span>
              ) : (
                <Icon
                  className="h-5 w-5 shrink-0 text-[var(--rc-new-muted)]"
                  aria-hidden
                />
              )}
              <span className={`text-2xl font-semibold tabular-nums ${stat.valueClass}`}>
                {stat.value}
              </span>
              <span className="text-xs text-[var(--rc-new-muted)]">
                {stat.label}
              </span>
            </div>
          );
        })}

        <div
          data-testid="preview-command-available"
          className="flex min-h-[68px] min-w-[235px] items-center gap-3 border-r border-[var(--rc-new-border)] px-5"
        >
          <UserRound className="h-5 w-5 shrink-0 text-nq-success" aria-hidden />
          <span className="min-w-0">
            <span className="block truncate text-base font-semibold text-nq-success">
              {availableStaffName ??
                (language === "vi" ? "Chưa có thợ trống" : "No one available")}
            </span>
            <span className="block text-[11px] text-[var(--rc-new-muted)]">
              {availableStaffName
                ? language === "vi"
                  ? "sẵn sàng"
                  : "available"
                : language === "vi"
                  ? "đang bận"
                  : "busy"}
            </span>
          </span>
        </div>

        <div className="flex min-h-[68px] min-w-[350px] flex-1 items-center gap-3 px-5">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-nq-primary/15 text-nq-primary">
            <Sparkles className="h-4 w-4" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--rc-new-text)]">
            {suggestion}
          </span>
          {canAct ? (
            <button
              type="button"
              onClick={onAction}
              className="h-8 shrink-0 rounded-lg border px-4 text-sm font-semibold transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-info"
              style={{
                borderColor: "var(--rc-new-control)",
                backgroundColor: "var(--rc-new-control)",
                color: "var(--rc-new-surface)",
              }}
            >
              {actionLabel}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
