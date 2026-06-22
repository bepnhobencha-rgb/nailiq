"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, XCircle, ChevronDown, ChevronUp, ShieldOff, Clock, CreditCard, CalendarDays, User, BellRing } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  loadDisputes,
  loadDisputeEvidence,
  type DisputeRow,
  type DisputeEvidence,
} from "@/shared/dashboard/loadDisputesAction";
import { getUserMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { formatCurrency } from "@/shared/lib/currencyFormat";

// ─── types ────────────────────────────────────────────────────────────────────

type PageState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; disputes: DisputeRow[]; needsResponse: number };

type EvidenceState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; evidence: DisputeEvidence };

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Days remaining until evidenceDueAt (may be negative = overdue). */
function daysUntil(iso: string): number {
  const due = new Date(iso).getTime();
  const now = Date.now();
  return Math.ceil((due - now) / (1000 * 60 * 60 * 24));
}

function fmtDatetime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" });
}

function fmtMoney(cents: number | null | undefined, currency: string | null | undefined): string {
  if (cents == null) return "—";
  return formatCurrency(cents, currency) ?? "—";
}

// ─── status pill ──────────────────────────────────────────────────────────────

type StatusPillProps = {
  status: string | null;
  labels: Record<string, string>;
};

function StatusPill({ status, labels }: StatusPillProps) {
  const s = (status ?? "").toLowerCase();
  const label = labels[s] ?? status ?? "—";

  const variant =
    s === "needs_response"
      ? "danger"
      : s === "under_review"
        ? "warning"
        : s === "won"
          ? "success"
          : "neutral";

  return (
    <Badge variant={variant} state="default" size="sm">
      {label}
    </Badge>
  );
}

// ─── evidence-due badge ────────────────────────────────────────────────────────

function EvidenceDueBadge({
  evidenceDueAt,
  t,
}: {
  evidenceDueAt: string | null | undefined;
  t: ReturnType<typeof getUserMessages>["disputes"];
}) {
  if (!evidenceDueAt) return null;
  const days = daysUntil(evidenceDueAt);
  if (days < 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-nq-error">
        <Clock className="h-3.5 w-3.5" aria-hidden />
        {t.evidenceOverdue}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        days <= 2 ? "text-nq-error" : days <= 5 ? "text-nq-warning" : "text-nq-muted",
      )}
    >
      <Clock className="h-3.5 w-3.5" aria-hidden />
      {t.evidenceDueIn(days)}
    </span>
  );
}

// ─── evidence field row ────────────────────────────────────────────────────────

function EvidenceRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="w-full shrink-0 text-[11px] font-semibold uppercase tracking-wide text-nq-muted sm:w-32">
        {label}
      </dt>
      <dd className="text-sm text-nq-foreground">{value ?? "—"}</dd>
    </div>
  );
}

// ─── evidence section ────────────────────────────────────────────────────────

function EvidenceSection({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-nq-muted">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {title}
      </h3>
      <dl className="space-y-1.5 rounded-lg border border-nq-border/40 bg-nq-surface/60 px-3 py-2">
        {children}
      </dl>
    </div>
  );
}

// ─── evidence bundle ───────────────────────────────────────────────────────────

function EvidenceBundle({
  slug,
  disputeId,
  t,
}: {
  slug: string;
  disputeId: string;
  t: ReturnType<typeof getUserMessages>["disputes"];
}) {
  const [state, setState] = useState<EvidenceState>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load evidence on mount
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void (async () => {
      const res = await loadDisputeEvidence(slug, disputeId);
      if (cancelled) return;
      if (res.ok) setState({ kind: "ok", evidence: res.evidence });
      else setState({ kind: "error", message: res.error });
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, disputeId]);

  // Build plain-text copy of the evidence bundle
  const buildPlainText = useCallback(
    (evidence: DisputeEvidence): string => {
      const lines: string[] = [
        `=== ${t.evidenceTitle} ===`,
        "",
        `[${t.sectionConsent}]`,
        evidence.consentAt
          ? `${t.fields.consentAt}: ${fmtDatetime(evidence.consentAt)}`
          : t.noConsentWarning,
        "",
        `[${t.sectionCharge}]`,
        `${t.fields.chargeAmount}: ${fmtMoney(evidence.charge.amountCents, evidence.charge.currency)}`,
        `${t.fields.paymentRef}: ${evidence.charge.paymentRef ?? "—"}`,
        "",
      ];
      if (evidence.booking) {
        lines.push(
          `[${t.sectionBooking}]`,
          `${t.fields.service}: ${evidence.booking.serviceName ?? "—"}`,
          `${t.fields.staff}: ${evidence.booking.staffName ?? "—"}`,
          `${t.fields.time}: ${fmtDatetime(evidence.booking.startUtc)}`,
          `${t.fields.bookingStatus}: ${evidence.booking.status ?? "—"}`,
          `${t.fields.price}: ${fmtMoney(evidence.booking.priceCents, evidence.charge.currency)}`,
          "",
        );
      }
      if (evidence.customer) {
        lines.push(
          `[${t.sectionCustomer}]`,
          `${t.fields.clientName}: ${evidence.customer.name ?? "—"}`,
          `${t.fields.phone}: ${evidence.customer.phone ?? "—"}`,
          `${t.fields.email}: ${evidence.customer.email ?? "—"}`,
          `${t.fields.visitCount}: ${evidence.customer.visitCount}`,
          "",
        );
      }
      if (evidence.noShowAudit) {
        lines.push(
          `[${t.sectionNoShow}]`,
          `${t.fields.noShowAt}: ${fmtDatetime(evidence.noShowAudit.at)}`,
          `${t.fields.noShowBy}: ${evidence.noShowAudit.actorRole ?? "—"}`,
          "",
        );
      }
      if (evidence.notifications.length > 0) {
        lines.push(`[${t.sectionNotifications}]`);
        evidence.notifications.forEach((n, i) => {
          lines.push(
            `${i + 1}. ${n.type} / ${n.channel} — ${n.status} — ${fmtDatetime(n.sentAt)}`,
          );
        });
        lines.push("");
      }
      return lines.join("\n");
    },
    [t],
  );

  const handleCopy = useCallback(async () => {
    if (state.kind !== "ok") return;
    const text = buildPlainText(state.evidence);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      /* ignore clipboard errors */
    }
  }, [state, buildPlainText]);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <div className="mt-3 space-y-2" role="status" aria-busy>
        <Skeleton className="h-5 w-40" rounded="rounded-md" />
        <Skeleton className="h-16" rounded="rounded-lg" />
        <Skeleton className="h-16" rounded="rounded-lg" />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <p
        role="alert"
        className="mt-3 rounded-md border border-nq-error/40 bg-nq-error/10 px-3 py-2 text-sm text-nq-error"
      >
        {t.evidenceError}
      </p>
    );
  }

  const { evidence } = state;

  return (
    <div className="mt-4 space-y-4" data-testid="disputes-evidence-bundle">
      {/* Header + copy button */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-nq-foreground">{t.evidenceTitle}</h2>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
            "border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
            copied
              ? "border-nq-success/40 bg-nq-success/10 text-nq-success"
              : "border-nq-border bg-nq-surface text-nq-muted hover:bg-nq-surface/80 hover:text-nq-foreground",
          )}
          aria-label={copied ? t.copiedEvidence : t.copyEvidence}
          data-testid="disputes-copy-evidence"
        >
          {copied ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          {copied ? t.copiedEvidence : t.copyEvidence}
        </button>
      </div>

      {/* 1. Consent */}
      <EvidenceSection icon={CheckCircle2} title={t.sectionConsent}>
        {evidence.consentAt ? (
          <EvidenceRow label={t.fields.consentAt} value={fmtDatetime(evidence.consentAt)} />
        ) : (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-md border border-nq-error/40 bg-nq-error/10 px-3 py-2 text-sm font-medium text-nq-error"
          >
            <ShieldOff className="h-4 w-4 shrink-0" aria-hidden />
            {t.noConsentWarning}
          </div>
        )}
      </EvidenceSection>

      {/* 2. Charge */}
      <EvidenceSection icon={CreditCard} title={t.sectionCharge}>
        <EvidenceRow
          label={t.fields.chargeAmount}
          value={fmtMoney(evidence.charge.amountCents, evidence.charge.currency)}
        />
        <EvidenceRow label={t.fields.paymentRef} value={evidence.charge.paymentRef ?? "—"} />
      </EvidenceSection>

      {/* 3. Booking */}
      {evidence.booking ? (
        <EvidenceSection icon={CalendarDays} title={t.sectionBooking}>
          <EvidenceRow label={t.fields.service} value={evidence.booking.serviceName} />
          <EvidenceRow label={t.fields.staff} value={evidence.booking.staffName} />
          <EvidenceRow label={t.fields.time} value={fmtDatetime(evidence.booking.startUtc)} />
          <EvidenceRow label={t.fields.bookingStatus} value={evidence.booking.status} />
          <EvidenceRow
            label={t.fields.price}
            value={fmtMoney(evidence.booking.priceCents, evidence.charge.currency)}
          />
        </EvidenceSection>
      ) : null}

      {/* 4. Customer */}
      {evidence.customer ? (
        <EvidenceSection icon={User} title={t.sectionCustomer}>
          <EvidenceRow label={t.fields.clientName} value={evidence.customer.name} />
          <EvidenceRow label={t.fields.phone} value={evidence.customer.phone} />
          <EvidenceRow label={t.fields.email} value={evidence.customer.email} />
          <EvidenceRow
            label={t.fields.visitCount}
            value={String(evidence.customer.visitCount)}
          />
        </EvidenceSection>
      ) : null}

      {/* 5. No-show audit */}
      {evidence.noShowAudit ? (
        <EvidenceSection icon={XCircle} title={t.sectionNoShow}>
          <EvidenceRow label={t.fields.noShowAt} value={fmtDatetime(evidence.noShowAudit.at)} />
          <EvidenceRow label={t.fields.noShowBy} value={evidence.noShowAudit.actorRole} />
        </EvidenceSection>
      ) : null}

      {/* 6. Notifications */}
      {evidence.notifications.length > 0 ? (
        <EvidenceSection icon={BellRing} title={t.sectionNotifications}>
          {evidence.notifications.map((n, i) => (
            <div key={i} className="grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-4">
              <EvidenceRow label={i === 0 ? t.fields.notifType : ""} value={n.type} />
              <EvidenceRow label={i === 0 ? t.fields.notifChannel : ""} value={n.channel} />
              <EvidenceRow label={i === 0 ? t.fields.notifStatus : ""} value={n.status} />
              <EvidenceRow label={i === 0 ? t.fields.notifSentAt : ""} value={fmtDatetime(n.sentAt)} />
            </div>
          ))}
        </EvidenceSection>
      ) : null}
    </div>
  );
}

// ─── dispute card ──────────────────────────────────────────────────────────────

function DisputeCard({
  dispute,
  slug,
  t,
}: {
  dispute: DisputeRow;
  slug: string;
  t: ReturnType<typeof getUserMessages>["disputes"];
}) {
  const [open, setOpen] = useState(false);

  const providerLabel =
    dispute.provider.toLowerCase() === "stripe"
      ? t.providerStripe
      : dispute.provider.toLowerCase() === "square"
        ? t.providerSquare
        : dispute.provider;

  const providerBadgeVariant =
    dispute.provider.toLowerCase() === "stripe" ? "info" : "neutral";

  return (
    <Card
      variant="default"
      padding="md"
      data-testid="disputes-dispute-card"
      className="space-y-3"
    >
      {/* Summary row */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "flex w-full cursor-pointer flex-col gap-3 text-left sm:flex-row sm:items-start sm:gap-4",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45 rounded",
        )}
        aria-expanded={open}
      >
        {/* Left: provider + client + amount */}
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={providerBadgeVariant} state="subtle" size="sm">
              {providerLabel}
            </Badge>
            <StatusPill status={dispute.status} labels={t.status} />
          </div>
          <p className="text-sm font-semibold text-nq-foreground">
            {dispute.clientName ?? t.noInfo}
          </p>
          <p className="text-xs text-nq-muted">
            {fmtMoney(dispute.amountCents, dispute.currency)}
            {dispute.reason ? <> · {dispute.reason}</> : null}
          </p>
        </div>

        {/* Right: dates + chevron */}
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <EvidenceDueBadge evidenceDueAt={dispute.evidenceDueAt} t={t} />
          <span className="text-xs text-nq-muted">
            {t.labelOpened}: {fmtDate(dispute.createdAt)}
          </span>
          {open ? (
            <ChevronUp className="mt-0.5 h-4 w-4 text-nq-muted" aria-hidden />
          ) : (
            <ChevronDown className="mt-0.5 h-4 w-4 text-nq-muted" aria-hidden />
          )}
        </div>
      </button>

      {/* Evidence bundle — expand on click */}
      {open ? (
        <EvidenceBundle slug={slug} disputeId={dispute.id} t={t} />
      ) : null}
    </Card>
  );
}

// ─── main panel ───────────────────────────────────────────────────────────────

export function DisputesPanel({ slug }: { slug: string }) {
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).disputes, [language]);

  const [state, setState] = useState<PageState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void (async () => {
      const res = await loadDisputes(slug);
      if (cancelled) return;
      if (res.ok)
        setState({ kind: "ok", disputes: res.disputes, needsResponse: res.needsResponse });
      else setState({ kind: "error", message: res.error });
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <div className="space-y-4" data-testid="disputes-panel">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-nq-foreground">{t.pageTitle}</h1>
        <p className="text-sm text-nq-muted">{t.intro}</p>
      </div>

      {/* Needs-response alert */}
      {state.kind === "ok" && state.needsResponse > 0 ? (
        <div
          role="alert"
          data-testid="disputes-needs-response-alert"
          className="flex items-center gap-2.5 rounded-lg border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm font-semibold text-nq-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          {t.needsResponseAlert(state.needsResponse)}
        </div>
      ) : null}

      {/* Error */}
      {state.kind === "error" ? (
        <p
          role="alert"
          data-testid="disputes-error"
          className="rounded-md border border-nq-error/40 bg-nq-error/10 px-3 py-2 text-sm text-nq-error"
        >
          {t.errorGeneric}
        </p>
      ) : null}

      {/* Loading skeleton */}
      {state.kind === "loading" ? (
        <div className="space-y-3" role="status" aria-busy aria-label={t.loading}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" rounded="rounded-xl" />
          ))}
        </div>
      ) : null}

      {/* Empty state */}
      {state.kind === "ok" && state.disputes.length === 0 ? (
        <Card
          variant="default"
          padding="lg"
          data-testid="disputes-empty"
          className="flex flex-col items-center gap-2 text-center"
        >
          <CheckCircle2 className="h-8 w-8 text-nq-success" aria-hidden />
          <p className="text-base font-semibold text-nq-foreground">{t.emptyTitle}</p>
          <p className="text-sm text-nq-muted">{t.emptyBody}</p>
        </Card>
      ) : null}

      {/* Dispute list */}
      {state.kind === "ok" && state.disputes.length > 0 ? (
        <div className="space-y-3" data-testid="disputes-list">
          {state.disputes.map((d) => (
            <DisputeCard key={d.id} dispute={d} slug={slug} t={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
