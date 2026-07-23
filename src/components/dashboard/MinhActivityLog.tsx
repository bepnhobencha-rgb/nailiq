"use client";

import { useMemo, useState } from "react";
import type { MinhActivityData, MinhLogEntry } from "@/shared/ai/loadMinhActivity";

// ─── helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === 0) return "Hôm nay";
  if (diffDays === 1) return "Hôm qua";
  return d.toLocaleDateString("vi-VN", { day: "numeric", month: "long" });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

function groupByDay(entries: MinhLogEntry[]): [string, MinhLogEntry[]][] {
  const map = new Map<string, MinhLogEntry[]>();
  for (const e of entries) {
    const key = e.createdAt.slice(0, 10);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(e);
  }
  return Array.from(map.entries());
}

// ─── sub-components ─────────────────────────────────────────────────────────

function StatCard({ label, value, sub, tone }: {
  label: string;
  value: number;
  sub?: string;
  tone?: "green" | "yellow" | "red" | "default";
}) {
  const colors: Record<string, string> = {
    green: "text-green-400",
    yellow: "text-yellow-400",
    red: "text-red-400",
    default: "text-nq-foreground",
  };
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-nq-border/30 bg-nq-surface/50 px-4 py-3">
      <span className="text-xs text-nq-muted">{label}</span>
      <span className={`text-2xl font-bold ${colors[tone ?? "default"]}`}>{value}</span>
      {sub && <span className="text-xs text-nq-muted">{sub}</span>}
    </div>
  );
}

function OutcomeBadge({ outcome, trackable }: { outcome: MinhLogEntry["outcome"]; trackable: boolean }) {
  if (!trackable) return null;
  if (outcome === "converted")
    return <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-400">✅ Quay lại</span>;
  if (outcome === "no_conversion")
    return <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-400">❌ Không quay lại</span>;
  return <span className="rounded-full bg-yellow-500/15 px-2 py-0.5 text-xs text-yellow-400">⏳ Đang chờ</span>;
}

function ActionLabel({ actionType }: { actionType: string }) {
  const map: Record<string, string> = {
    sent_sms: "SMS",
    sent_email: "Email",
    sent: "Gửi",
    alert: "Cảnh báo",
    caption_drafted: "Draft caption",
    review_replied: "Reply review",
    report_sent: "Báo cáo",
  };
  return (
    <span className="rounded bg-nq-border/20 px-1.5 py-0.5 text-xs text-nq-muted">
      {map[actionType] ?? actionType}
    </span>
  );
}

function EntryRow({ entry }: { entry: MinhLogEntry }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <span className="mt-0.5 shrink-0 text-lg leading-none">{entry.agentIcon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-nq-foreground">{entry.agentLabel}</span>
          <ActionLabel actionType={entry.actionType} />
          {entry.clientName && (
            <span className="text-xs text-nq-muted">→ {entry.clientName}</span>
          )}
          <OutcomeBadge outcome={entry.outcome} trackable={entry.trackable} />
        </div>
        {entry.messagePreview && (
          <p className="mt-0.5 line-clamp-1 text-xs text-nq-muted/70 italic">
            &ldquo;{entry.messagePreview}&rdquo;
          </p>
        )}
      </div>
      <span className="shrink-0 text-xs text-nq-muted/60">{formatTime(entry.createdAt)}</span>
    </div>
  );
}

// ─── main ────────────────────────────────────────────────────────────────────

const FILTERS = [
  { key: "all", label: "Tất cả" },
  { key: "trackable", label: "Khách hàng" },
  { key: "converted", label: "✅ Quay lại" },
  { key: "pending", label: "⏳ Chờ kết quả" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

export function MinhActivityLog({ data }: { data: MinhActivityData }) {
  const [filter, setFilter] = useState<FilterKey>("all");

  const filtered = useMemo(() => {
    if (filter === "trackable") return data.entries.filter((e) => e.trackable);
    if (filter === "converted") return data.entries.filter((e) => e.outcome === "converted");
    if (filter === "pending") return data.entries.filter((e) => e.trackable && e.outcome === null);
    return data.entries;
  }, [data.entries, filter]);

  const grouped = useMemo(() => groupByDay(filtered), [filtered]);
  const overallPct = data.totalSent > 0
    ? Math.round((data.converted / data.totalSent) * 100)
    : null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-4 sm:p-6">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-nq-foreground">✨ Nhật ký Minh</h1>
        <p className="mt-0.5 text-xs text-nq-muted">30 ngày gần nhất — những gì AI Manager đã làm cho tiệm</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Đã gửi" value={data.totalSent} sub="tin nhắn khách hàng" />
        <StatCard
          label="Quay lại"
          value={data.converted}
          sub={overallPct != null ? `${overallPct}% hiệu quả` : "chưa có data"}
          tone="green"
        />
        <StatCard label="Đang chờ" value={data.pending} sub="chưa hết window" tone="yellow" />
        <StatCard label="Không quay lại" value={data.noConversion} tone="red" />
      </div>

      {/* Per-agent conversion */}
      {data.agentStats.length > 0 && (
        <div className="rounded-xl border border-nq-border/30 bg-nq-surface/35 p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-nq-muted">
            Hiệu quả theo agent (30 ngày)
          </p>
          <div className="flex flex-wrap gap-2">
            {data.agentStats.map((s) => (
              <div
                key={s.agent}
                className="flex items-center gap-1.5 rounded-full border border-nq-border/30 bg-nq-surface/60 px-3 py-1"
              >
                <span>{s.icon}</span>
                <span className="text-xs text-nq-foreground">{s.label}</span>
                <span className={`text-xs font-bold ${s.pct >= 30 ? "text-green-400" : s.pct >= 10 ? "text-yellow-400" : "text-nq-muted"}`}>
                  {s.sent > 0 ? `${s.pct}%` : "–"}
                </span>
                <span className="text-xs text-nq-muted/60">({s.converted}/{s.sent})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs transition-colors ${
              filter === f.key
                ? "bg-nq-primary text-nq-bg font-semibold"
                : "bg-nq-border/20 text-nq-muted hover:text-nq-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Timeline */}
      {grouped.length === 0 ? (
        <div className="rounded-xl border border-nq-border/30 bg-nq-surface/35 p-8 text-center">
          <p className="text-2xl">🤖</p>
          <p className="mt-2 text-sm text-nq-muted">Minh chưa có hành động nào trong khoảng này.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(([dateKey, entries]) => (
            <div key={dateKey} className="rounded-xl border border-nq-border/30 bg-nq-surface/35 px-4">
              <p className="border-b border-nq-border/20 py-2 text-xs font-semibold text-nq-muted">
                {formatDate(entries[0].createdAt)}
              </p>
              <div className="divide-y divide-nq-border/15">
                {entries.map((e) => <EntryRow key={e.id} entry={e} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
