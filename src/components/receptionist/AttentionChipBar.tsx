"use client";

/**
 * AttentionChipBar — a slim, single-row summary of "needs attention" items
 * that sits directly above the timeline grid. Each chip shows a count; tapping
 * it opens an overlay dropdown (absolutely positioned, so it covers the grid
 * instead of pushing it down) with the detailed list + 1-tap actions.
 *
 * Replaces the old always-expanded amber attention box (overdue + no-show
 * lists) and the always-open party-card strip, both of which ate the grid's
 * vertical real estate. When nothing needs attention the bar renders nothing,
 * so the grid owns the full height.
 *
 * Progressive disclosure: glanceable counts always visible, detail on demand.
 */

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export type AttentionOverdueItem = {
  id: string;
  client_name: string | null;
  start_time_utc: string;
};

export type AttentionNoShowItem = {
  id: string;
  clientName: string | null;
  startTimeUtc: string;
};

export type AttentionGroupSummary = {
  /** Non-expired party bookings in the visible window. */
  active: number;
  /** Slots still unclaimed across those parties + pending change requests. */
  unconfirmed: number;
};

type ChipKey = "all" | "overdue" | "noshow" | "groups" | "waitlist";

export type AttentionWaitlistSummary = {
  /** Active waitlist entries (waiting + notified + recently claimed). */
  total: number;
  /** Entries the customer already claimed → staff must create the booking. */
  claimed: number;
  /** Unresolved online leads. Zero when the attention pilot is disabled. */
  waiting?: number;
  /** Age of the oldest unresolved lead, when its timestamp is trustworthy. */
  oldestWaitingMinutes?: number | null;
};

export function AttentionChipBar({
  language,
  overdue,
  noShowsToday,
  groupSummary,
  groupsContent,
  waitlistSummary,
  waitlistContent,
  busy,
  removedLabel,
  formatTime,
  displayName,
  onOpenBooking,
  onMarkNoShow,
  onUndoNoShow,
  embedded = false,
}: {
  language: "en" | "vi";
  overdue: AttentionOverdueItem[];
  noShowsToday: AttentionNoShowItem[];
  groupSummary: AttentionGroupSummary | null;
  /** Rendered inside the groups dropdown (e.g. <PartyCardPanel/>). */
  groupsContent: ReactNode | null;
  /** Online-waitlist counts driving the "Chờ chỗ" chip + its badge. */
  waitlistSummary: AttentionWaitlistSummary | null;
  /** Rendered inside the waitlist dropdown (the <OnlineWaitlistPanel/>). */
  waitlistContent: ReactNode | null;
  busy: boolean;
  removedLabel: string;
  formatTime: (utcIso: string) => string;
  displayName: (name: string | null, removedLabel: string) => string;
  onOpenBooking: (id: string) => void;
  onMarkNoShow: (id: string) => void;
  onUndoNoShow?: (id: string) => void;
  /** Compact trigger for use inside the unified Action Center bar. */
  embedded?: boolean;
}) {
  const [open, setOpen] = useState<ChipKey | null>(null);

  const vi = language === "vi";
  const hasOverdue = overdue.length > 0;
  const hasNoShow = noShowsToday.length > 0;
  const hasGroups = !!groupSummary && groupsContent != null && groupSummary.active > 0;
  const hasWaitlist =
    !!waitlistSummary && waitlistContent != null && waitlistSummary.total > 0;
  const totalItems =
    overdue.length +
    noShowsToday.length +
    (groupSummary?.active ?? 0) +
    (waitlistSummary?.total ?? 0);
  const hasUrgent =
    hasOverdue ||
    (waitlistSummary?.claimed ?? 0) > 0 ||
    (waitlistSummary?.waiting ?? 0) > 0;

  // Close the dropdown on Escape for keyboard users.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Nothing to surface → don't take any space at all.
  if (!hasOverdue && !hasNoShow && !hasGroups && !hasWaitlist) return null;

  const toggle = (key: ChipKey) => setOpen((cur) => (cur === key ? null : key));

  return (
    <div
      className={cn(
        "relative z-20",
        embedded ? "shrink-0" : "mx-3 mt-3",
      )}
    >
      {/* ── Chip row ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={embedded ? "contents" : "xl:hidden"}>
          <Chip
            testId="attention-chip-all"
            active={open === "all"}
            tone={hasUrgent ? "danger" : "primary"}
            pulse={hasUrgent}
            onClick={() => toggle("all")}
            icon="✓"
            label={vi ? "Việc cần xử lý" : "Action center"}
            count={totalItems}
            largeTouch={embedded}
          />
        </span>

        <span className={embedded ? "hidden" : "hidden xl:contents"}>
          {hasOverdue ? (
            <Chip
              testId="attention-chip-overdue"
              active={open === "overdue"}
              tone="danger"
              pulse
              onClick={() => toggle("overdue")}
              icon="⏰"
              label={vi ? "Quá giờ" : "Overdue"}
              count={overdue.length}
            />
          ) : null}

          {hasNoShow ? (
            <Chip
              testId="attention-chip-noshow"
              active={open === "noshow"}
              tone="muted"
              onClick={() => toggle("noshow")}
              icon="🚫"
              label={vi ? "Vắng hôm nay" : "No-show today"}
              count={noShowsToday.length}
            />
          ) : null}

          {hasGroups ? (
            <Chip
              testId="attention-chip-groups"
              active={open === "groups"}
              tone="primary"
              onClick={() => toggle("groups")}
              icon="👥"
              label={vi ? "Nhóm" : "Groups"}
              count={groupSummary!.active}
              subBadge={
                groupSummary!.unconfirmed > 0
                  ? `${groupSummary!.unconfirmed} ${vi ? "chưa xác nhận" : "unconfirmed"}`
                  : null
              }
            />
          ) : null}

          {hasWaitlist ? (
            <Chip
              testId="attention-chip-waitlist"
              active={open === "waitlist"}
              tone="primary"
              pulse={
                waitlistSummary!.claimed > 0 ||
                (waitlistSummary!.waiting ?? 0) > 0
              }
              onClick={() => toggle("waitlist")}
              icon="⏳"
              label={vi ? "Chờ chỗ" : "Waitlist"}
              count={waitlistSummary!.total}
              subBadge={
                waitlistSummary!.claimed > 0
                  ? `${waitlistSummary!.claimed} ${vi ? "cần tạo lịch" : "to book"}`
                  : (waitlistSummary!.waiting ?? 0) > 0
                    ? waitlistSummary!.oldestWaitingMinutes == null
                      ? `${waitlistSummary!.waiting} ${vi ? "đang chờ" : "waiting"}`
                      : vi
                        ? `lâu nhất ${waitlistSummary!.oldestWaitingMinutes} phút`
                        : `oldest ${waitlistSummary!.oldestWaitingMinutes} min`
                    : null
              }
            />
          ) : null}
        </span>
      </div>

      {/* ── Dropdown overlay (covers the grid, never pushes it) ───────── */}
      {open ? (
        <>
          {/* Click-away backdrop. */}
          <button
            type="button"
            aria-label={vi ? "Đóng" : "Close"}
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setOpen(null)}
          />
          <div
            role="dialog"
            aria-modal="false"
            className={cn(
              "absolute top-full z-30 mt-1.5",
              embedded
                ? "right-0 w-[min(34rem,calc(100vw-2rem))]"
                : "left-0 right-0",
              "max-h-[60vh] overflow-y-auto overflow-x-hidden",
              "rounded-2xl border border-nq-border/50 bg-nq-bg/95 backdrop-blur",
              "shadow-[var(--shadow-nq-lg,0_12px_32px_rgba(0,0,0,0.28))]",
            )}
          >
            {open === "all" ? (
              <div className="flex items-center gap-2 border-b border-nq-border/40 px-3 py-2.5">
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-nq-primary/15 text-sm text-nq-primary"
                  aria-hidden
                >
                  ✓
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-nq-foreground">
                    {vi ? "Việc cần xử lý" : "Action center"}
                  </p>
                  <p className="text-xs text-nq-muted">
                    {vi
                      ? `${totalItems} mục trong một nơi`
                      : `${totalItems} items in one place`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(null)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-nq-muted hover:bg-nq-surface hover:text-nq-foreground"
                  aria-label={vi ? "Đóng" : "Close"}
                >
                  ✕
                </button>
              </div>
            ) : null}

            {open === "overdue" || (open === "all" && hasOverdue) ? (
              <Section
                title={`⏰ ${vi ? "Quá giờ — chưa bắt đầu" : "Overdue — not started"}`}
                count={overdue.length}
                tone="danger"
              >
                {overdue.map((b) => (
                  <Row key={b.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onOpenBooking(b.id);
                        setOpen(null);
                      }}
                      className="min-w-0 flex-1 truncate text-left text-nq-foreground"
                    >
                      <span className="font-medium">
                        {displayName(b.client_name, removedLabel)}
                      </span>
                      <span className="text-nq-muted">
                        {" · "}
                        {formatTime(b.start_time_utc)}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onMarkNoShow(b.id)}
                      className="shrink-0 rounded-full border border-red-400/40 px-3 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-400/10 disabled:opacity-50"
                    >
                      {vi ? "Vắng" : "No-show"}
                    </button>
                  </Row>
                ))}
              </Section>
            ) : null}

            {open === "noshow" || (open === "all" && hasNoShow) ? (
              <Section
                title={vi ? "Đã đánh dấu vắng hôm nay" : "Marked no-show today"}
                count={noShowsToday.length}
                tone="muted"
              >
                {noShowsToday.map((ns) => (
                  <Row key={ns.id}>
                    <span className="min-w-0 flex-1 truncate text-nq-muted line-through">
                      {displayName(ns.clientName, removedLabel)}
                      <span>
                        {" · "}
                        {formatTime(ns.startTimeUtc)}
                      </span>
                    </span>
                    {onUndoNoShow ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onUndoNoShow(ns.id)}
                        className="shrink-0 rounded-full border border-emerald-400/40 px-3 py-1 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-400/10 disabled:opacity-50"
                      >
                        {vi ? "Bỏ vắng (đã đến)" : "Undo (arrived)"}
                      </button>
                    ) : null}
                  </Row>
                ))}
              </Section>
            ) : null}

            {(open === "groups" || open === "all") && hasGroups ? (
              <div
                className={cn(
                  "p-1.5",
                  open === "all" && "border-t border-nq-border/30",
                )}
              >
                {open === "all" ? (
                  <p className="px-2 pt-2 text-xs font-semibold uppercase tracking-wide text-nq-primary">
                    👥 {vi ? "Nhóm" : "Groups"} ({groupSummary!.active})
                  </p>
                ) : null}
                {groupsContent}
              </div>
            ) : null}

            {(open === "waitlist" || open === "all") && hasWaitlist ? (
              <div
                className={cn(
                  "p-1.5",
                  open === "all" && "border-t border-nq-border/30",
                )}
              >
                {open === "all" ? (
                  <p className="px-2 pt-2 text-xs font-semibold uppercase tracking-wide text-nq-primary">
                    ⏳ {vi ? "Chờ chỗ" : "Waitlist"} ({waitlistSummary!.total})
                  </p>
                ) : null}
                {waitlistContent}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ─── Chip ──────────────────────────────────────────────────────────────

function Chip({
  testId,
  active,
  tone,
  pulse,
  onClick,
  icon,
  label,
  count,
  subBadge,
  largeTouch = false,
}: {
  testId: string;
  active: boolean;
  tone: "danger" | "muted" | "primary";
  pulse?: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  count: number;
  subBadge?: string | null;
  largeTouch?: boolean;
}) {
  const toneCls =
    tone === "danger"
      ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
      : tone === "primary"
        ? "border-nq-primary/40 bg-nq-primary/10 text-nq-primary"
        : "border-nq-border/50 bg-nq-surface/50 text-nq-muted";

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      aria-expanded={active}
      className={cn(
        "group relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-all",
        largeTouch && "min-h-11",
        toneCls,
        active && "ring-2 ring-current/30",
        "hover:brightness-110 active:scale-[0.97]",
      )}
    >
      {pulse ? (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-70" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      ) : (
        <span aria-hidden>{icon}</span>
      )}
      <span className="font-semibold tabular-nums">{count}</span>
      <span className="hidden sm:inline">{label}</span>
      {subBadge ? (
        <span className="ml-0.5 rounded-full bg-nq-warning/20 px-1.5 py-0.5 text-[10px] font-medium text-nq-warning">
          {subBadge}
        </span>
      ) : null}
      <span
        aria-hidden
        className={cn(
          "ml-0.5 text-[10px] opacity-60 transition-transform",
          active && "rotate-180",
        )}
      >
        ▾
      </span>
    </button>
  );
}

// ─── Dropdown section + row ────────────────────────────────────────────

function Section({
  title,
  count,
  tone,
  children,
}: {
  title: string;
  count: number;
  tone: "danger" | "muted";
  children: ReactNode;
}) {
  return (
    <div className="p-2.5">
      <p
        className={cn(
          "mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide",
          tone === "danger" ? "text-amber-300" : "text-nq-muted",
        )}
      >
        {title} ({count})
      </p>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-nq-surface/40 px-2.5 py-1.5 text-sm">
      {children}
    </div>
  );
}
