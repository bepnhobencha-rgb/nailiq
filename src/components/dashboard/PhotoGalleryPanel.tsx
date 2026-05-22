"use client";

import { useState, useMemo } from "react";
import type { PhotoRow } from "@/app/dashboard/[slug]/photos/page";

type Props = {
  slug: string;
  photos: PhotoRow[];
};

type DateFilter = "all" | "today" | "week" | "month";

const RATING_EMOJI = ["", "😞", "😐", "🙂", "😊", "🤩"] as const;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
  });
}

function qualityBadge(score: number | null): { label: string; color: string } | null {
  if (score == null) return null;
  if (score >= 0.8) return { label: `${Math.round(score * 100)}%`, color: "text-emerald-400 bg-emerald-400/10" };
  if (score >= 0.6) return { label: `${Math.round(score * 100)}%`, color: "text-yellow-400 bg-yellow-400/10" };
  return { label: `${Math.round(score * 100)}%`, color: "text-red-400 bg-red-400/10" };
}

function isWithin(iso: string, filter: DateFilter): boolean {
  if (filter === "all") return true;
  const now = Date.now();
  const ts = new Date(iso).getTime();
  if (filter === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return ts >= start.getTime();
  }
  if (filter === "week") return ts >= now - 7 * 24 * 60 * 60 * 1000;
  if (filter === "month") return ts >= now - 30 * 24 * 60 * 60 * 1000;
  return true;
}

export function PhotoGalleryPanel({ slug, photos }: Props) {
  const [dateFilter, setDateFilter] = useState<DateFilter>("month");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(
    () => photos.filter((p) => isWithin(p.created_at, dateFilter)),
    [photos, dateFilter],
  );

  const selected = useMemo(
    () => filtered.find((p) => p.id === selectedId) ?? null,
    [filtered, selectedId],
  );

  const avgRating = useMemo(() => {
    const rated = filtered.filter((p) => p.customer_rating != null);
    if (!rated.length) return null;
    return rated.reduce((s, p) => s + p.customer_rating!, 0) / rated.length;
  }, [filtered]);

  const avgQuality = useMemo(() => {
    const scored = filtered.filter((p) => p.ai_quality_score != null);
    if (!scored.length) return null;
    return scored.reduce((s, p) => s + p.ai_quality_score!, 0) / scored.length;
  }, [filtered]);

  const smsRate = useMemo(() => {
    if (!filtered.length) return null;
    const sent = filtered.filter((p) => p.sms_sent_at != null).length;
    return Math.round((sent / filtered.length) * 100);
  }, [filtered]);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">Photos</h1>
          <p className="text-sm text-nq-muted mt-0.5">
            {filtered.length} photo{filtered.length !== 1 ? "s" : ""} · last 90 days
          </p>
        </div>

        {/* Date filter */}
        <div className="flex gap-1 rounded-xl border border-nq-border/40 bg-nq-surface p-1 self-start sm:self-auto">
          {(["today", "week", "month", "all"] as DateFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setDateFilter(f)}
              className="rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors"
              style={{
                background: dateFilter === f ? "var(--color-nq-primary)" : "transparent",
                color: dateFilter === f ? "var(--color-nq-bg)" : "var(--color-nq-muted)",
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Stats bar */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-nq-border/40 bg-nq-surface px-4 py-3 text-center">
            <p className="text-xl font-bold text-nq-foreground">
              {avgRating != null ? avgRating.toFixed(1) : "—"}
            </p>
            <p className="text-xs text-nq-muted mt-0.5">Avg rating</p>
          </div>
          <div className="rounded-xl border border-nq-border/40 bg-nq-surface px-4 py-3 text-center">
            <p className="text-xl font-bold text-nq-foreground">
              {avgQuality != null ? `${Math.round(avgQuality * 100)}%` : "—"}
            </p>
            <p className="text-xs text-nq-muted mt-0.5">AI quality</p>
          </div>
          <div className="rounded-xl border border-nq-border/40 bg-nq-surface px-4 py-3 text-center">
            <p className="text-xl font-bold text-nq-foreground">
              {smsRate != null ? `${smsRate}%` : "—"}
            </p>
            <p className="text-xs text-nq-muted mt-0.5">SMS sent</p>
          </div>
        </div>
      )}

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-nq-border/40 bg-nq-surface py-16 text-center">
          <span className="text-5xl">📸</span>
          <div>
            <p className="text-base font-semibold text-nq-foreground">No photos yet</p>
            <p className="text-sm text-nq-muted mt-1">
              Staff can add photos from the booking detail page after completing an appointment.
            </p>
          </div>
          <a
            href={`/dashboard/${encodeURIComponent(slug)}/center`}
            className="rounded-full bg-nq-primary px-4 py-2 text-sm font-semibold text-nq-bg hover:opacity-90"
          >
            Go to Live Board
          </a>
        </div>
      )}

      {/* Photo grid */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {filtered.map((photo) => {
            const qb = qualityBadge(photo.ai_quality_score);
            return (
              <button
                key={photo.id}
                type="button"
                onClick={() => setSelectedId(photo.id === selectedId ? null : photo.id)}
                className="group relative flex flex-col rounded-xl border overflow-hidden text-left transition-all hover:ring-2 focus-visible:outline-none focus-visible:ring-2"
                style={{
                  background: "var(--color-nq-surface)",
                  borderColor:
                    selectedId === photo.id
                      ? "var(--color-nq-primary)"
                      : "rgba(255,255,255,0.08)",
                }}
              >
                {/* Thumbnail */}
                <div className="relative aspect-square w-full overflow-hidden bg-nq-bg">
                  {photo.signedUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={photo.signedUrl}
                      alt={photo.clientName ?? "Nail photo"}
                      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-3xl">
                      💅
                    </div>
                  )}

                  {/* AI quality badge */}
                  {qb && (
                    <span
                      className={`absolute bottom-1.5 left-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${qb.color}`}
                    >
                      {qb.label}
                    </span>
                  )}

                  {/* Rating badge */}
                  {photo.customer_rating != null && (
                    <span className="absolute bottom-1.5 right-1.5 text-sm">
                      {RATING_EMOJI[photo.customer_rating]}
                    </span>
                  )}

                  {/* Not viewed indicator */}
                  {photo.sms_sent_at && !photo.customer_viewed_at && (
                    <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-nq-primary" />
                  )}
                </div>

                {/* Caption */}
                <div className="px-2.5 py-2">
                  <p className="truncate text-xs font-medium text-nq-foreground leading-tight">
                    {photo.clientName ?? "Unknown"}
                  </p>
                  <p className="truncate text-[10px] text-nq-muted mt-0.5 leading-tight">
                    {photo.serviceName ?? "—"} · {formatShortDate(photo.created_at)}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Detail panel — slides in below grid on mobile, or inline drawer */}
      {selected && (
        <div
          className="rounded-2xl border p-5 flex flex-col gap-4"
          style={{
            background: "var(--color-nq-surface)",
            borderColor: "rgba(255,255,255,0.1)",
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-nq-foreground">
                {selected.clientName ?? "Unknown client"}
              </h2>
              <p className="text-sm text-nq-muted">
                {selected.serviceName ?? "—"}
                {selected.staffName ? ` · with ${selected.staffName}` : ""}
              </p>
              {selected.appointmentDate && (
                <p className="text-xs text-nq-muted mt-0.5">{formatDate(selected.appointmentDate)}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="rounded-lg p-1.5 text-nq-muted hover:text-nq-foreground hover:bg-white/5"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="AI quality" value={selected.ai_quality_score != null ? `${Math.round(selected.ai_quality_score * 100)}%` : "—"} />
            <Stat label="Customer rating" value={selected.customer_rating != null ? `${RATING_EMOJI[selected.customer_rating]} ${selected.customer_rating}/5` : "—"} />
            <Stat label="SMS sent" value={selected.sms_sent_at ? formatShortDate(selected.sms_sent_at) : "Not sent"} />
            <Stat label="Viewed" value={selected.customer_viewed_at ? formatShortDate(selected.customer_viewed_at) : "Not opened"} />
          </div>

          {selected.ai_detected_style && (
            <div>
              <p className="text-xs font-medium text-nq-muted uppercase tracking-wider mb-1.5">AI Style</p>
              <p className="text-sm text-nq-foreground">{selected.ai_detected_style}</p>
            </div>
          )}

          {selected.ai_detected_colors && selected.ai_detected_colors.length > 0 && (
            <div>
              <p className="text-xs font-medium text-nq-muted uppercase tracking-wider mb-1.5">Colors detected</p>
              <div className="flex flex-wrap gap-1.5">
                {selected.ai_detected_colors.map((c) => (
                  <span
                    key={c}
                    className="rounded-full px-2.5 py-1 text-xs"
                    style={{ background: "rgba(255,255,255,0.08)", color: "var(--color-nq-foreground)" }}
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            {selected.signedUrl && (
              <a
                href={selected.signedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full px-4 py-2 text-sm font-semibold"
                style={{ background: "var(--color-nq-primary)", color: "var(--color-nq-bg)" }}
              >
                View full photo
              </a>
            )}
            <a
              href={`/dashboard/${encodeURIComponent(slug)}/center`}
              className="rounded-full border px-4 py-2 text-sm font-semibold text-nq-foreground hover:bg-white/5"
              style={{ borderColor: "rgba(255,255,255,0.12)" }}
            >
              Go to booking
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-nq-border/40 bg-nq-bg/40 px-3 py-2.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-nq-muted">{label}</p>
      <p className="text-sm font-semibold text-nq-foreground mt-0.5">{value}</p>
    </div>
  );
}
