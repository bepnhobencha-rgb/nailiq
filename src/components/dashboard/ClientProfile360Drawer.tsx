"use client";

/**
 * ClientProfile360Drawer — full "Customer 360" slide-over profile drawer.
 *
 * Opens when a staff member clicks a client NAME in ClientProfilesPanel.
 * Fetches enriched profile data via loadClientProfile360 and optionally
 * triggers generateClient360Summary in the background for the AI card.
 *
 * Uses the repo's <Drawer> primitive (Framer Motion, focus trap, Esc-to-close).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  getUserMessages,
  type ReceptionistMessages,
} from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import {
  loadClientProfile360,
  generateClient360Summary,
  type C360Booking,
  type ClientProfile360,
} from "@/shared/dashboard/loadClientProfile360Action";
import { sendClientMessage } from "@/shared/dashboard/sendClientMessageAction";

// C360Booking and ClientProfile360 types are imported from
// "@/shared/dashboard/loadClientProfile360Action" above.
// Re-export them so callers can use this file as a single import surface.
export type { C360Booking, ClientProfile360 };

// Aliases to keep the call sites readable
const callLoadProfile = loadClientProfile360;
const callGenerateSummary = generateClient360Summary;

// SMS body character limit (standard single SMS segment)
const SMS_MAX_CHARS = 160;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCents(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return "$0.00";
  return `$${(cents / 100).toFixed(2)}`;
}

function formatCentsCompact(cents: number): string {
  const dollars = Math.round((cents || 0) / 100);
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(1)}k`;
  return `$${dollars}`;
}

/** Format a full date, locale-aware based on UI language. */
function formatDate(iso: string | null, lang: "en" | "vi" = "en"): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const locale = lang === "vi" ? "vi-VN" : "en-US";
  return d.toLocaleDateString(locale, {
    day: "numeric",
    month: "numeric",
    year: "numeric",
  });
}

/** Format a short date (e.g. "14 Jun 2026"), locale-aware. */
function formatDateShort(iso: string | null, lang: "en" | "vi" = "en"): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const locale = lang === "vi" ? "vi-VN" : "en-US";
  return d.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function initialsOf(name: string | null): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]![0] : "";
  return (first + last).toUpperCase() || "?";
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ClientProfile360DrawerProps {
  slug: string;
  clientPhone: string | null;
  viewerRole: string;
  onClose: () => void;
  /** Optional: called when the user taps "Book again". No-op safe. */
  onBookAgain?: (phone: string) => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Pulsing shimmer block for AI card loading state. */
function AiShimmer({ label }: { label: string }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label={label}>
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

/** Section header with consistent uppercase labelling. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
      {children}
    </p>
  );
}

/** Consent chip — green if on, muted if off. */
function ConsentChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        on
          ? "border-nq-success/40 bg-nq-success/10 text-nq-success"
          : "border-nq-border/40 bg-transparent text-nq-muted line-through",
      )}
    >
      {on ? "✓" : "✗"} {label}
    </span>
  );
}

/** Status pill for a booking entry. */
function StatusPill({ status, m }: { status: string; m: ReceptionistMessages["clientProfiles"]["profile360"] }) {
  const { label, cls } = (() => {
    switch (status) {
      case "completed":
        return { label: m.statusCompleted, cls: "border-nq-success/40 bg-nq-success/10 text-nq-success" };
      case "cancelled":
        return { label: m.statusCancelled, cls: "border-nq-border/40 bg-nq-surface text-nq-muted" };
      case "no_show":
        return { label: m.statusNoShow, cls: "border-nq-error/40 bg-nq-error/10 text-nq-error" };
      case "in_progress":
        return { label: m.statusInProgress, cls: "border-nq-warning/40 bg-nq-warning/10 text-nq-warning" };
      default:
        return { label: m.statusConfirmed, cls: "border-nq-info/40 bg-nq-info/10 text-nq-info" };
    }
  })();

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
        cls,
      )}
    >
      {label}
    </span>
  );
}

/** Channel icon (tiny, aria-hidden). */
function ChannelIcon({ channel, m }: { channel: string | null; m: ReceptionistMessages["clientProfiles"]["profile360"] }) {
  if (!channel) return null;
  const { icon, title } = (() => {
    switch (channel) {
      case "online": return { icon: "🌐", title: m.channelOnline };
      case "walkin": return { icon: "🚶", title: m.channelWalkin };
      case "voice": return { icon: "🎙️", title: m.channelVoice };
      default: return { icon: "📋", title: m.channelDesk };
    }
  })();
  return <span title={title} aria-hidden className="text-xs">{icon}</span>;
}

/** Reliability bar — three-segment horizontal bar. */
function ReliabilityBar({
  completed,
  noShow,
  cancelled,
  total,
  noShowRatePct,
  m,
}: {
  completed: number;
  noShow: number;
  cancelled: number;
  total: number;
  noShowRatePct: number;
  m: ReceptionistMessages["clientProfiles"]["profile360"];
}) {
  if (total === 0) return null;
  const cPct = Math.round((completed / total) * 100);
  const nPct = Math.round((noShow / total) * 100);
  const xPct = 100 - cPct - nPct;
  const rateColor = noShowRatePct >= 30 ? "text-nq-error" : noShowRatePct >= 15 ? "text-nq-warning" : "text-nq-success";

  return (
    <div className="space-y-2">
      {/* Bar */}
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-nq-bg/60">
        {cPct > 0 ? (
          <div
            style={{ width: `${cPct}%` }}
            className="bg-nq-success transition-all"
            title={`${completed} completed`}
          />
        ) : null}
        {nPct > 0 ? (
          <div
            style={{ width: `${nPct}%` }}
            className="bg-nq-error transition-all"
            title={`${noShow} no-show`}
          />
        ) : null}
        {xPct > 0 ? (
          <div
            style={{ width: `${xPct}%` }}
            className="bg-nq-muted/30 transition-all"
            title={`${cancelled} cancelled`}
          />
        ) : null}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-xs">
        <span>
          <span className="inline-block h-2 w-2 rounded-full bg-nq-success" /> {m.completed}: <strong>{completed}</strong>
        </span>
        <span>
          <span className="inline-block h-2 w-2 rounded-full bg-nq-error" /> {m.noShow}: <strong>{noShow}</strong>
        </span>
        <span>
          <span className="inline-block h-2 w-2 rounded-full bg-nq-muted/30" /> {m.cancelled}: <strong>{cancelled}</strong>
        </span>
        <span className={cn("font-semibold", rateColor)}>
          {m.noShowRate(noShowRatePct)}
        </span>
      </div>
    </div>
  );
}

/** One booking entry in the visit timeline. */
function TimelineEntry({
  booking,
  m,
  highlight,
  lang,
}: {
  booking: C360Booking;
  m: ReceptionistMessages["clientProfiles"]["profile360"];
  highlight?: boolean;
  lang: "en" | "vi";
}) {
  const dateStr = formatDate(booking.startUtc, lang);
  const timeStr = formatTime(booking.startUtc);

  return (
    <li
      className={cn(
        "flex gap-3 rounded-xl border px-3 py-2.5 text-sm",
        highlight
          ? "border-nq-primary/30 bg-nq-primary/5"
          : "border-nq-border/30 bg-transparent",
      )}
    >
      {/* Date column */}
      <div className="w-16 shrink-0">
        <p className="font-mono text-xs tabular-nums text-nq-muted">{dateStr}</p>
        {timeStr ? (
          <p className="font-mono text-[10px] tabular-nums text-nq-muted/60">
            {timeStr}
          </p>
        ) : null}
      </div>

      {/* Service / staff */}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-nq-foreground">{booking.serviceName}</p>
        {booking.staffName ? (
          <p className="truncate text-xs text-nq-muted">{booking.staffName}</p>
        ) : null}
      </div>

      {/* Price + status + channel */}
      <div className="flex shrink-0 flex-col items-end gap-1">
        {booking.priceCents != null ? (
          <span className="font-mono text-xs font-semibold tabular-nums text-nq-foreground">
            {formatCents(booking.priceCents)}
          </span>
        ) : null}
        <div className="flex items-center gap-1">
          <StatusPill status={booking.status} m={m} />
          <ChannelIcon channel={booking.channel} m={m} />
        </div>
      </div>
    </li>
  );
}

/** Star rating display. */
function StarRating({ rating }: { rating: number }) {
  return (
    <span aria-label={`${rating} out of 5 stars`} className="text-sm text-amber-400">
      {"★".repeat(rating)}{"☆".repeat(Math.max(0, 5 - rating))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// In-app SMS composer
// ---------------------------------------------------------------------------

type ComposeKind = "message" | "rebook_invite";

interface SmsComposeState {
  open: boolean;
  body: string;
  kind: ComposeKind;
  /** null = idle, "sending" = in flight, "sent" | "suppressed" | string(error) = result */
  status: null | "sending" | "sent" | "suppressed" | { error: string };
}

interface SmsComposerProps {
  phone: string;
  slug: string;
  state: SmsComposeState;
  onStateChange: (s: SmsComposeState) => void;
  /** Called after a successful send so the parent can refresh data. */
  onSentRefresh: () => void;
  m: ReceptionistMessages["clientProfiles"]["profile360"];
}

function SmsComposer({
  phone,
  slug,
  state,
  onStateChange,
  onSentRefresh,
  m,
}: SmsComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus textarea when composer opens
  useEffect(() => {
    if (state.open) {
      // Small delay to let CSS transition complete
      const t = setTimeout(() => textareaRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [state.open]);

  if (!state.open) return null;

  const charCount = state.body.length;
  const overLimit = charCount > SMS_MAX_CHARS;
  const isSending = state.status === "sending";
  const sentOk = state.status === "sent" || state.status === "suppressed";

  async function handleSend() {
    if (isSending || overLimit || !state.body.trim()) return;
    onStateChange({ ...state, status: "sending" });

    try {
      const result = await sendClientMessage(slug, {
        phone,
        body: state.body,
        kind: state.kind,
      });

      if (result.ok) {
        const nextStatus = result.suppressed ? "suppressed" : "sent";
        onStateChange({ ...state, status: nextStatus });
        // If truly sent, close after a moment + refresh
        if (!result.suppressed) {
          setTimeout(() => {
            onStateChange({ open: false, body: "", kind: "message", status: null });
            onSentRefresh();
          }, 1400);
        }
      } else {
        onStateChange({ ...state, status: { error: result.error } });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      onStateChange({ ...state, status: { error: msg } });
    }
  }

  function handleCancel() {
    onStateChange({ open: false, body: "", kind: "message", status: null });
  }

  const resultNote = (() => {
    if (state.status === "sent") return { text: m.composeSent, cls: "text-nq-success" };
    if (state.status === "suppressed") return { text: m.composeSentSuppressed, cls: "text-nq-warning" };
    if (state.status && typeof state.status === "object" && "error" in state.status) {
      return { text: m.composeError(state.status.error), cls: "text-nq-error" };
    }
    return null;
  })();

  return (
    <div
      role="region"
      aria-label={m.actionMessage}
      className={cn(
        "overflow-hidden rounded-2xl border border-nq-primary/30 bg-nq-primary/5",
        "motion-safe:animate-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200",
      )}
    >
      <div className="px-4 pt-3 pb-2">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-nq-primary">
          {m.actionMessage} — {phone}
        </p>

        <label htmlFor="sms-compose-body" className="sr-only">
          {m.composePlaceholder}
        </label>
        <textarea
          id="sms-compose-body"
          ref={textareaRef}
          rows={4}
          maxLength={SMS_MAX_CHARS + 20} /* soft clamp — warn via counter */
          value={state.body}
          onChange={(e) =>
            onStateChange({ ...state, body: e.target.value, status: null })
          }
          placeholder={m.composePlaceholder}
          disabled={isSending || sentOk}
          className={cn(
            "w-full resize-none rounded-xl border bg-nq-surface px-3 py-2 text-sm",
            "placeholder:text-nq-muted/50 focus:outline-none focus:ring-2",
            overLimit
              ? "border-nq-error/60 focus:ring-nq-error/30"
              : "border-nq-border/50 focus:ring-nq-primary/30",
            "disabled:opacity-60",
          )}
        />

        {/* Char counter */}
        <p
          className={cn(
            "mt-1 text-right text-[11px] tabular-nums",
            overLimit ? "font-semibold text-nq-error" : "text-nq-muted",
          )}
          aria-live="polite"
        >
          {m.composeCharCount(charCount, SMS_MAX_CHARS)}
        </p>

        {/* Result note */}
        {resultNote ? (
          <p
            role="status"
            aria-live="polite"
            className={cn("mt-1.5 text-xs font-medium", resultNote.cls)}
          >
            {resultNote.text}
          </p>
        ) : null}
      </div>

      {/* Actions */}
      <div className="flex gap-2 border-t border-nq-border/20 px-4 py-2.5">
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="flex-1"
          onClick={handleSend}
          disabled={isSending || sentOk || overLimit || !state.body.trim()}
        >
          {isSending ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                aria-hidden
              />
              {m.composeSend}…
            </span>
          ) : (
            m.composeSend
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleCancel}
          disabled={isSending}
        >
          {m.composeCancel}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main drawer component
// ---------------------------------------------------------------------------

export function ClientProfile360Drawer({
  slug,
  clientPhone,
  onClose,
  onBookAgain,
}: ClientProfile360DrawerProps) {
  const isOpen = clientPhone !== null;
  const { language } = useUserLanguage();
  // language from useUserLanguage is UserLanguage = "en" | "vi"
  const lang = language as "en" | "vi";
  const m = useMemo(
    () => getUserMessages(language).receptionist.clientProfiles.profile360,
    [language],
  );

  // Fetch state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ClientProfile360 | null>(null);

  // AI summary state
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiSummary, setAiSummary] = useState<ClientProfile360["aiSummary"] | null>(null);

  // Timeline show-more
  const [showAllTimeline, setShowAllTimeline] = useState(false);
  const TIMELINE_CAP = 20;

  // In-app SMS compose state
  const [compose, setCompose] = useState<SmsComposeState>({
    open: false,
    body: "",
    kind: "message",
    status: null,
  });

  // Build booking URL for rebook-invite template
  const bookingUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca"}/${slug}`;

  // Reset + fetch when phone changes
  useEffect(() => {
    if (!clientPhone) {
      setData(null);
      setError(null);
      setAiSummary(null);
      setShowAllTimeline(false);
      setCompose({ open: false, body: "", kind: "message", status: null });
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setAiSummary(null);
    setShowAllTimeline(false);
    setCompose({ open: false, body: "", kind: "message", status: null });

    void callLoadProfile(slug, clientPhone, language).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        setError(m.error);
        return;
      }
      setData(res.data);

      // If AI summary already present, use it; otherwise generate in background
      if (res.data.aiSummary) {
        setAiSummary(res.data.aiSummary);
      } else {
        setAiGenerating(true);
        void callGenerateSummary(slug, clientPhone, language).then((aiRes) => {
          if (cancelled) return;
          setAiGenerating(false);
          if (aiRes.ok) {
            setAiSummary({
              text: aiRes.text,
              nextAction: aiRes.nextAction,
              computedAt: aiRes.computedAt,
            });
          }
          // On error: just hide the AI card gracefully
        });
      }
    });

    return () => {
      cancelled = true;
    };
  // Re-runs on language change so the AI summary + dates re-fetch in the new
  // language (the rest of the UI is reactive via getUserMessages already).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, clientPhone, language]);

  /** Re-fetch the profile (e.g. after a message is sent to pick up notification history). */
  const refreshProfile = useCallback(() => {
    if (!clientPhone) return;
    void callLoadProfile(slug, clientPhone, language).then((res) => {
      if (res.ok) setData(res.data);
    });
  }, [slug, clientPhone, language]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleBookAgain = useCallback(() => {
    if (clientPhone && onBookAgain) onBookAgain(clientPhone);
    onClose();
  }, [clientPhone, onBookAgain, onClose]);

  /** Open composer for a blank new message. */
  const handleOpenMessage = useCallback(() => {
    setCompose({ open: true, body: "", kind: "message", status: null });
  }, []);

  /** Open composer pre-filled with rebook-invite text. */
  const handleOpenRebookInvite = useCallback(() => {
    if (!data) return;
    const firstName =
      (data.profile.name?.trim().split(/\s+/)[0]) ?? "";
    const service =
      data.favorites.topServiceName ?? null;
    const staff =
      data.favorites.topStaffName ?? data.profile.preferredStaffName ?? null;

    const body = m.rebookInviteTemplate({ firstName, service, staff, bookingUrl });
    setCompose({ open: true, body, kind: "rebook_invite", status: null });
  }, [data, m, bookingUrl]);

  /** Re-generate AI summary. */
  const handleRegenerateSummary = useCallback(() => {
    if (!clientPhone || aiGenerating) return;
    setAiGenerating(true);
    setAiSummary(null);
    void callGenerateSummary(slug, clientPhone, language).then((aiRes) => {
      setAiGenerating(false);
      if (aiRes.ok) {
        setAiSummary({
          text: aiRes.text,
          nextAction: aiRes.nextAction,
          computedAt: aiRes.computedAt,
        });
      }
    });
  }, [slug, clientPhone, aiGenerating]);

  // ── Build title ──────────────────────────────────────────────────────────
  const drawerTitle = data?.profile.name?.trim() ?? m.title;

  // ── Timeline slicing ──────────────────────────────────────────────────────
  const visibleTimeline = useMemo(() => {
    if (!data) return [];
    const all = data.timeline;
    return showAllTimeline ? all : all.slice(0, TIMELINE_CAP);
  }, [data, showAllTimeline]);

  const hasMoreTimeline = data ? data.timeline.length > TIMELINE_CAP && !showAllTimeline : false;

  // ── Footer ────────────────────────────────────────────────────────────────
  const footer = data ? (
    <div className="w-full space-y-2">
      {/* In-app SMS composer — rendered above the footer buttons */}
      {data.profile.phone ? (
        <SmsComposer
          phone={data.profile.phone}
          slug={slug}
          state={compose}
          onStateChange={setCompose}
          onSentRefresh={refreshProfile}
          m={m}
        />
      ) : null}

      {/* Footer action buttons */}
      <div className="flex w-full flex-wrap gap-2">
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="flex-1"
          onClick={handleOpenRebookInvite}
          disabled={!data.profile.phone}
        >
          {m.actionBookAgain}
        </Button>
        {data.profile.phone ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="flex-1"
            onClick={handleOpenMessage}
          >
            {m.actionMessage}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={handleClose}>
          {m.actionClose}
        </Button>
      </div>
    </div>
  ) : null;

  return (
    <Drawer
      isOpen={isOpen}
      onClose={handleClose}
      variant="right"
      size="lg"
      title={drawerTitle}
      footer={footer}
      aria-label={m.title}
    >
      <div
        data-testid="client-360-drawer"
        className="space-y-5 text-sm"
      >
        {/* ── Loading ── */}
        {loading ? (
          <div aria-busy="true" aria-label={m.loading} className="space-y-4">
            {/* Hero shimmer */}
            <div className="flex items-center gap-4">
              <Skeleton className="h-16 w-16 shrink-0" rounded="rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-5 w-1/2" />
                <Skeleton className="h-4 w-1/3" />
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
            <Skeleton className="h-24" />
            <Skeleton className="h-32" />
          </div>
        ) : null}

        {/* ── Error ── */}
        {error && !loading ? (
          <p
            role="alert"
            className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
          >
            {error}
          </p>
        ) : null}

        {/* ── Content ── */}
        {data && !loading ? (
          <>
            {/* ═══════════════════════════════════════════════════════════════
              1. HERO — avatar + KPI strip
            ═══════════════════════════════════════════════════════════════ */}
            <section className="space-y-4">
              {/* Avatar + name + VIP + phone */}
              <div className="flex items-center gap-4">
                <div
                  aria-hidden
                  className={cn(
                    "flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-xl font-bold",
                    data.profile.isVip
                      ? "bg-nq-primary/15 text-nq-primary ring-2 ring-nq-primary/50"
                      : "bg-nq-bg/70 text-nq-foreground ring-1 ring-nq-border/60",
                  )}
                >
                  {initialsOf(data.profile.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-bold text-nq-foreground">
                      {data.profile.name?.trim() || "(chưa có tên)"}
                    </h3>
                    {data.profile.isVip ? (
                      <Badge variant="vip" size="sm">
                        👑 VIP
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 font-mono text-sm tabular-nums text-nq-muted">
                    {data.profile.phone}
                  </p>
                  {data.profile.createdAt ? (
                    <p className="text-xs text-nq-muted">
                      {m.clientSince(formatDateShort(data.profile.createdAt, lang))}
                    </p>
                  ) : null}
                </div>
              </div>

              {/* KPI strip */}
              <dl className="grid grid-cols-4 gap-2 rounded-2xl border border-nq-border/40 bg-nq-surface/50 px-3 py-3">
                <KpiCell label={m.lifetimeSpent} value={formatCentsCompact(data.stats.lifetimeSpentCents)} />
                <KpiCell label={m.visits} value={String(data.stats.visitCount)} />
                <KpiCell label={m.avgTicket} value={formatCentsCompact(data.stats.avgTicketCents)} />
                <KpiCell label={m.lastVisit} value={formatDate(data.stats.lastVisitAt, lang)} />
              </dl>
            </section>

            {/* ═══════════════════════════════════════════════════════════════
              2. AI SUMMARY — gold-accented card
            ═══════════════════════════════════════════════════════════════ */}
            {(aiGenerating || aiSummary) ? (
              <section className="space-y-2 rounded-2xl border border-nq-primary/30 bg-nq-primary/5 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-base" aria-hidden>🤖</span>
                    <SectionLabel>{m.aiSummaryTitle}</SectionLabel>
                  </div>
                  {/* Regenerate button — replaces the old redundant "Đặt lại" */}
                  {aiSummary && !aiGenerating ? (
                    <button
                      type="button"
                      onClick={handleRegenerateSummary}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-lg border border-nq-border/40",
                        "px-2 py-1 text-[11px] font-semibold text-nq-muted",
                        "transition hover:border-nq-primary/40 hover:text-nq-primary",
                      )}
                    >
                      ↺ {m.regenerateSummary}
                    </button>
                  ) : null}
                </div>
                {aiGenerating && !aiSummary ? (
                  <AiShimmer label={m.aiGenerating} />
                ) : aiSummary ? (
                  <div className="space-y-2">
                    <p className="text-sm leading-relaxed text-nq-foreground/90">
                      {aiSummary.text}
                    </p>
                    {aiSummary.nextAction ? (
                      <div className="rounded-lg border border-nq-primary/25 bg-nq-primary/10 px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-primary">
                          {m.aiNextAction}
                        </p>
                        <p className="mt-0.5 text-sm font-medium text-nq-foreground">
                          {aiSummary.nextAction}
                        </p>
                      </div>
                    ) : null}
                    {/* Regenerate shimmer shown during regen when old summary is still visible */}
                    {aiGenerating ? <AiShimmer label={m.aiGenerating} /> : null}
                  </div>
                ) : null}
              </section>
            ) : null}

            {/* ═══════════════════════════════════════════════════════════════
              3. RELIABILITY
            ═══════════════════════════════════════════════════════════════ */}
            {data.reliability.total > 0 ? (
              <section className="space-y-2 border-t border-nq-border/20 pt-4">
                <SectionLabel>{m.reliabilityTitle}</SectionLabel>
                <ReliabilityBar
                  completed={data.reliability.completed}
                  noShow={data.reliability.noShow}
                  cancelled={data.reliability.cancelled}
                  total={data.reliability.total}
                  noShowRatePct={data.reliability.noShowRatePct}
                  m={m}
                />
              </section>
            ) : null}

            {/* ═══════════════════════════════════════════════════════════════
              4. FAVORITES & PATTERN
            ═══════════════════════════════════════════════════════════════ */}
            {(data.favorites.topServiceName || data.favorites.topStaffName || data.pattern) ? (
              <section className="space-y-3 border-t border-nq-border/20 pt-4">
                {(data.favorites.topServiceName || data.favorites.topStaffName) ? (
                  <>
                    <SectionLabel>{m.favoritesTitle}</SectionLabel>
                    <dl className="grid grid-cols-2 gap-2">
                      {data.favorites.topServiceName ? (
                        <div>
                          <dt className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                            {m.topService}
                          </dt>
                          <dd className="mt-0.5 text-sm font-medium text-nq-foreground">
                            {data.favorites.topServiceName}
                          </dd>
                        </div>
                      ) : null}
                      {(data.favorites.topStaffName ?? data.profile.preferredStaffName) ? (
                        <div>
                          <dt className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                            {m.topStaff}
                          </dt>
                          <dd className="mt-0.5 text-sm font-medium text-nq-foreground">
                            {data.favorites.topStaffName ?? data.profile.preferredStaffName}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </>
                ) : null}

                {data.pattern && (
                  data.pattern.recurringWeekday != null ||
                  data.pattern.nextPredictedAt != null
                ) ? (
                  <>
                    <SectionLabel>{m.patternTitle}</SectionLabel>
                    {data.pattern.recurringWeekday != null &&
                     data.pattern.recurringHour != null &&
                     data.pattern.recurrenceDays != null ? (
                      <p className="text-sm text-nq-foreground">
                        {m.usualPattern(
                          m.weekdays[data.pattern.recurringWeekday] ?? String(data.pattern.recurringWeekday),
                          data.pattern.recurringHour,
                          data.pattern.recurrenceDays,
                        )}
                      </p>
                    ) : null}
                    {data.pattern.nextPredictedAt ? (
                      <p className="text-sm text-nq-muted">
                        <span className="font-semibold text-nq-foreground">{m.nextPredicted}:</span>{" "}
                        {formatDateShort(data.pattern.nextPredictedAt, lang)}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </section>
            ) : null}

            {/* ═══════════════════════════════════════════════════════════════
              5. PREFERENCES
            ═══════════════════════════════════════════════════════════════ */}
            {data.preferences ? (
              <section className="space-y-3 border-t border-nq-border/20 pt-4">
                <SectionLabel>{m.preferencesTitle}</SectionLabel>

                {/* Allergies warning — red callout when present */}
                {data.preferences.allergies ? (
                  <div className="flex items-start gap-2 rounded-xl border border-nq-error/40 bg-nq-error/10 px-3 py-2">
                    <p className="text-sm font-semibold text-nq-error">
                      {m.allergiesWarning}
                    </p>
                    <p className="flex-1 text-sm text-nq-error/80">
                      {data.preferences.allergies}
                    </p>
                  </div>
                ) : null}

                <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {data.preferences.favoriteColors ? (
                    <PrefItem label={m.favoriteColors} value={data.preferences.favoriteColors} />
                  ) : null}
                  {data.preferences.favoriteStyles ? (
                    <PrefItem label={m.favoriteStyles} value={data.preferences.favoriteStyles} />
                  ) : null}
                  {data.preferences.language ? (
                    <PrefItem label={m.language} value={data.preferences.language} />
                  ) : null}
                  {data.preferences.commChannel ? (
                    <PrefItem label={m.commChannel} value={data.preferences.commChannel} />
                  ) : null}
                </dl>

                {/* Consents */}
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                    {m.consentsTitle}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <ConsentChip label={m.consentSms} on={data.preferences.consents.sms} />
                    <ConsentChip label={m.consentEmail} on={data.preferences.consents.email} />
                    <ConsentChip label={m.consentAi} on={data.preferences.consents.ai} />
                  </div>
                </div>
              </section>
            ) : null}

            {/* ═══════════════════════════════════════════════════════════════
              6. MONEY — spent summary + loyalty + vouchers
            ═══════════════════════════════════════════════════════════════ */}
            {(data.loyalty || data.vouchers.length > 0) ? (
              <section className="space-y-3 border-t border-nq-border/20 pt-4">
                <SectionLabel>{m.moneyTitle}</SectionLabel>

                {data.loyalty ? (
                  <dl className="grid grid-cols-2 gap-2 rounded-xl border border-nq-border/30 bg-nq-surface/40 px-3 py-2.5">
                    <PrefItem
                      label={m.loyaltyStamps}
                      value={`${data.loyalty.stampsCurrent} / ${data.loyalty.stampsLifetime}`}
                    />
                    <PrefItem
                      label={m.loyaltyRewards}
                      value={`${data.loyalty.rewardsEarned} earned · ${data.loyalty.rewardsRedeemed} used`}
                    />
                  </dl>
                ) : null}

                {data.vouchers.length > 0 ? (
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                      {m.activeVouchers}
                    </p>
                    <ul className="space-y-1">
                      {data.vouchers.map((v) => (
                        <li
                          key={v.code}
                          className="flex items-center justify-between rounded-lg border border-nq-border/30 bg-nq-surface/40 px-3 py-1.5"
                        >
                          <div>
                            <span className="font-mono text-xs font-semibold text-nq-foreground">
                              {v.code}
                            </span>{" "}
                            <span className="text-xs text-nq-muted">{v.label}</span>
                          </div>
                          {v.expiresAt ? (
                            <span className="text-[11px] text-nq-muted">
                              {m.expiresOn(formatDate(v.expiresAt, lang))}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            ) : null}

            {/* ═══════════════════════════════════════════════════════════════
              7. VISIT TIMELINE — upcoming + past
            ═══════════════════════════════════════════════════════════════ */}
            {(data.upcoming.length > 0 || visibleTimeline.length > 0) ? (
              <section className="space-y-3 border-t border-nq-border/20 pt-4">
                {/* Upcoming */}
                {data.upcoming.length > 0 ? (
                  <>
                    <SectionLabel>{m.upcomingTitle}</SectionLabel>
                    <ul className="space-y-1.5">
                      {data.upcoming.map((b) => (
                        <TimelineEntry key={b.id} booking={b} m={m} highlight lang={lang} />
                      ))}
                    </ul>
                  </>
                ) : null}

                {/* History */}
                {visibleTimeline.length > 0 ? (
                  <>
                    <SectionLabel>{m.timelineTitle}</SectionLabel>
                    <ul className="space-y-1.5">
                      {visibleTimeline.map((b) => (
                        <TimelineEntry key={b.id} booking={b} m={m} lang={lang} />
                      ))}
                    </ul>
                    {hasMoreTimeline ? (
                      <button
                        type="button"
                        onClick={() => setShowAllTimeline(true)}
                        className="w-full rounded-xl border border-nq-border/40 py-2 text-xs font-semibold text-nq-muted transition hover:text-nq-foreground"
                      >
                        {m.showMore} ({data.timeline.length - TIMELINE_CAP}+)
                      </button>
                    ) : null}
                  </>
                ) : null}
              </section>
            ) : null}

            {/* ═══════════════════════════════════════════════════════════════
              8. ENGAGEMENT — reviews + notifications + AI counts
            ═══════════════════════════════════════════════════════════════ */}
            {(data.reviews.length > 0 || data.notifications.length > 0 || data.ai.chatCount > 0 || data.ai.voiceCount > 0) ? (
              <section className="space-y-4 border-t border-nq-border/20 pt-4">
                {data.reviews.length > 0 ? (
                  <div className="space-y-2">
                    <SectionLabel>{m.reviewsTitle}</SectionLabel>
                    <ul className="space-y-2">
                      {data.reviews.map((r, i) => (
                        <li
                          key={i}
                          className="rounded-xl border border-nq-border/30 bg-nq-surface/40 px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <StarRating rating={r.rating} />
                            {r.staffName ? (
                              <span className="text-xs text-nq-muted">{r.staffName}</span>
                            ) : null}
                            {r.submittedAt ? (
                              <span className="text-[11px] tabular-nums text-nq-muted">
                                {formatDate(r.submittedAt, lang)}
                              </span>
                            ) : null}
                          </div>
                          {r.message ? (
                            <p className="mt-1 text-xs text-nq-foreground/80">
                              {r.message}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {data.notifications.length > 0 ? (
                  <div className="space-y-2">
                    <SectionLabel>{m.notificationsTitle}</SectionLabel>
                    <ul className="space-y-1">
                      {data.notifications.slice(0, 5).map((n, i) => (
                        <li
                          key={i}
                          className="flex items-center gap-2 rounded-lg border border-nq-border/20 px-3 py-1.5 text-xs"
                        >
                          <span className="rounded-full border border-nq-border/30 bg-nq-bg/50 px-1.5 py-0.5 text-[10px] font-mono text-nq-muted">
                            {n.type}
                          </span>
                          <span className="text-nq-muted">{n.channel}</span>
                          <span
                            className={cn(
                              "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                              n.status === "delivered"
                                ? "bg-nq-success/10 text-nq-success"
                                : "bg-nq-error/10 text-nq-error",
                            )}
                          >
                            {n.status}
                          </span>
                          {n.sentAt ? (
                            <span className="text-[10px] tabular-nums text-nq-muted/70">
                              {formatDate(n.sentAt, lang)}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {(data.ai.chatCount > 0 || data.ai.voiceCount > 0) ? (
                  <div className="space-y-2">
                    <SectionLabel>{m.aiEngagementTitle}</SectionLabel>
                    <dl className="grid grid-cols-3 gap-2">
                      <KpiCell label={m.chatCount} value={String(data.ai.chatCount)} />
                      <KpiCell label={m.voiceCount} value={String(data.ai.voiceCount)} />
                      {data.ai.lastInteractionAt ? (
                        <KpiCell label={m.lastInteraction} value={formatDate(data.ai.lastInteractionAt, lang)} />
                      ) : null}
                    </dl>
                  </div>
                ) : null}
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function KpiCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-nq-muted">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm font-bold tabular-nums text-nq-foreground">
        {value}
      </dd>
    </div>
  );
}

function PrefItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-nq-foreground">{value}</dd>
    </div>
  );
}
