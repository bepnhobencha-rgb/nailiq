"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivityItem, ActivityKind } from "@/shared/dashboard/loadActivityFeedAction";

const KIND_ICON: Record<ActivityKind, string> = {
  event: "🗓️",
  sms: "💬",
  email: "✉️",
  call: "📞",
  system: "⚙️",
  login: "🔑",
  ai: "🤖",
  watchdog: "🛡️",
};

const TABS: { key: ActivityKind | "all"; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "event", label: "Lịch hẹn" },
  { key: "sms", label: "SMS" },
  { key: "email", label: "Email" },
  { key: "call", label: "Cuộc gọi" },
  { key: "system", label: "Hệ thống" },
  { key: "login", label: "Đăng nhập" },
  { key: "ai", label: "AI" },
  { key: "watchdog", label: "Cảnh báo" },
];

function timeAgo(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "vừa xong";
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} ngày trước`;
  return new Date(ms).toLocaleDateString("vi-VN");
}

function StatusBadge({ status }: { status: string }) {
  const ok = status === "delivered";
  const bad = status === "failed" || status === "undelivered";
  const cls = ok
    ? "bg-nq-success/15 text-nq-success"
    : bad
      ? "bg-nq-error/15 text-nq-error"
      : "bg-nq-warning/15 text-nq-warning";
  const label = ok ? "✓ Đã nhận" : bad ? "✗ Lỗi" : "⏳ Đã gửi";
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cls}`}>{label}</span>;
}

export function ActivityFeed({ slug, items }: { slug: string; items: ActivityItem[] }) {
  const [tab, setTab] = useState<ActivityKind | "all">("all");
  const [open, setOpen] = useState<string | null>(null);

  // Read/unread like email: items newer than the last time the owner opened the
  // log show BOLD; already-seen ones are dimmed. Capture the PREVIOUS last-seen
  // marker on mount (for styling), then advance it to now so this same set reads
  // as "seen" next visit (and the bell badge clears).
  const seenKey = `activity-seen:${slug}`;
  // 0 = treat everything as unread (bold) until we've read the persisted marker.
  const [prevSeenMs, setPrevSeenMs] = useState<number>(0);
  const initedRef = useRef(false);
  useEffect(() => {
    // Run the read-then-advance ONCE, even under React StrictMode's double-invoke
    // (otherwise the 2nd run reads the marker the 1st run just wrote → all dim).
    if (initedRef.current) return;
    initedRef.current = true;
    try {
      const prev = window.localStorage.getItem(seenKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPrevSeenMs(prev ? Date.parse(prev) : 0);
      // Advance the marker AFTER capturing the previous value, so the items shown
      // in THIS view read as seen (dimmed) on the next visit.
      window.localStorage.setItem(seenKey, new Date().toISOString());
    } catch {
      /* storage blocked → everything reads as seen */
    }
  }, [seenKey]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const it of items) c[it.kind] = (c[it.kind] ?? 0) + 1;
    return c;
  }, [items]);

  const shown = tab === "all" ? items : items.filter((i) => i.kind === tab);

  return (
    <section className="rounded-2xl border border-nq-border bg-nq-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-nq-foreground">Nhật ký hoạt động</h1>
          <p className="mt-0.5 text-xs text-nq-muted">
            Tin nhắn, email, cuộc gọi và thay đổi lịch — xem lại bất cứ lúc nào. Bấm vào một mục
            lịch hẹn để mở lịch thật.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            data-testid={`activity-tab-${t.key}`}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === t.key
                ? "bg-nq-primary text-nq-bg"
                : "bg-nq-border/30 text-nq-muted hover:text-nq-foreground"
            }`}
          >
            {t.label}
            {counts[t.key] ? <span className="ml-1 opacity-70">{counts[t.key]}</span> : null}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="mt-6 text-sm italic text-nq-muted">Chưa có hoạt động nào.</p>
      ) : (
        <ul className="mt-4 divide-y divide-nq-border/50">
          {shown.map((it) => {
            const unread = Date.parse(it.when) > prevSeenMs;
            const inner = (
              <div className={`flex items-start gap-3 py-3 ${unread ? "" : "opacity-55"}`}>
                <span aria-hidden className="relative mt-0.5 text-base">
                  {KIND_ICON[it.kind]}
                  {unread ? (
                    <span className="absolute -left-2 top-1.5 h-1.5 w-1.5 rounded-full bg-nq-primary" />
                  ) : null}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-sm text-nq-foreground ${unread ? "font-semibold" : "font-normal"}`}>{it.title}</span>
                    {it.status ? <StatusBadge status={it.status} /> : null}
                    {it.bookingId ? (
                      <span className="text-[10px] font-semibold text-nq-primary">Xem lịch →</span>
                    ) : null}
                  </div>
                  {it.subtitle ? (
                    <p className={`mt-0.5 text-xs text-nq-muted ${open === it.id ? "" : "truncate"}`}>{it.subtitle}</p>
                  ) : null}
                  {(it.kind === "call" || it.kind === "ai" || it.kind === "watchdog") && it.transcript ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        setOpen(open === it.id ? null : it.id);
                      }}
                      className="mt-1 text-[11px] font-semibold text-nq-primary"
                    >
                      {open === it.id
                        ? it.kind === "call" ? "Ẩn bản ghi" : "Ẩn chi tiết"
                        : it.kind === "call" ? "Xem bản ghi cuộc gọi" : "Xem chi tiết →"}
                    </button>
                  ) : null}
                  {open === it.id && it.transcript ? (
                    <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-xl bg-nq-border/20 p-3 text-[11px] leading-relaxed text-nq-foreground">
                      {it.transcript}
                    </pre>
                  ) : null}
                </div>
                <span className="shrink-0 text-[10px] tabular-nums text-nq-muted">
                  {timeAgo(it.when)}
                </span>
              </div>
            );

            return (
              <li key={it.id} data-testid={`activity-row-${it.kind}`}>
                {it.bookingId ? (
                  <Link
                    href={`/dashboard/${slug}/center?${it.bookingDate ? `date=${it.bookingDate}&` : ""}booking=${it.bookingId}`}
                    className="block rounded-lg transition-colors hover:bg-nq-border/15"
                  >
                    {inner}
                  </Link>
                ) : (
                  inner
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
