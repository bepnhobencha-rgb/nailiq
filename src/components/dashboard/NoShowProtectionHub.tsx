"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  updateRemindersEnabled,
  updateReminderSettings,
  updateNoShowCardSettings,
  updateWaitlistAutoBook,
  waiveBookingDeposit,
  loadNoShowHistory,
} from "@/shared/noshow/noShowDashboardActions";
import type {
  NoShowSummary,
  UnconfirmedBooking,
  WaitlistOpportunity,
  UncollectedFee,
  NoShowHistoryItem,
} from "@/shared/noshow/noShowDashboardActions";
import {
  chargeNoShowFeeManual,
  waiveNoShowFee,
  sendNoShowFeeLink,
} from "@/shared/dashboard/receptionistActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getUserMessages } from "@/shared/i18n/user";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { MobileStack } from "@/components/layout/MobileStack";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { StripeConnectCard } from "@/components/dashboard/StripeConnectCard";

type Props = {
  slug: string;
  salonId: string;
  isOwner: boolean;
  autoBookEnabled: boolean;
  remindersEnabled: boolean;
  reminder24hEnabled: boolean;
  reminder3hEnabled: boolean;
  smsRemindersEnabled: boolean;
  depositHighValueCents: number;
  depositPctNoShow: number;
  depositPctHighValue: number;
  depositPctNewCustomer: number;
  /** Master ON/OFF for Square deposits (square_integrations.deposit_enabled). */
  depositEnabled: boolean;
  /** Grace minutes before an unpaid deposit-held slot auto-releases. */
  depositHoldGraceMinutes: number;
  /** Admin-editable cancellation/no-show/deposit policy (effective text, bilingual). */
  cancellationPolicyEn: string;
  cancellationPolicyVi: string;
  /** Effective health-acknowledgment requirement (salon override ?? vertical default). */
  healthAckEffective: boolean;
  /** Also email desk-sent links (save-card/deposit/waitlist) alongside SMS. */
  emailLinksEnabled: boolean;
  connectHasAccount: boolean;
  connectChargesEnabled: boolean;
  connectDetailsSubmitted: boolean;
  paymentProvider: "square" | "stripe" | null;
  noshowProtectionEnabled: boolean;
  /** Group organizer's card covers the whole party's no-show fee. */
  noshowGroupWholeParty: boolean;
  /** "Who is asked for a card" rules. */
  noshowRequireNewCustomer: boolean;
  noshowRequirePriorNoshow: boolean;
  noshowMinNoshowCount: number;
  noshowRequireHighRisk: boolean;
  /** Prior-no-show count that escalates to upfront pay-to-confirm deposit; null = off. */
  noshowDepositEscalationThreshold: number | null;
  noshowFeePercent: number;
  noshowRiskThreshold: number;
  /** Charge the no-show fee % when a customer self-cancels late (opt-in). */
  selfCancelFeeEnabled: boolean;
  /** Hours before start that a self-cancel counts as "late" (fee-eligible). */
  selfCancelWindowHours: number;
  /** Separate late-cancel fee %; null = same as the no-show %. */
  selfCancelFeePercent: number | null;
  summary: NoShowSummary;
  unconfirmed: UnconfirmedBooking[];
  waitlist: WaitlistOpportunity[];
  /** No-show fees the saved-card charge failed on — desk can retry / waive. */
  uncollectedFees: UncollectedFee[];
};

function formatTime(isoUtc: string): string {
  try {
    return new Date(isoUtc).toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return isoUtc;
  }
}

function RiskBadge({ score }: { score: number | null }) {
  if (score === null) return null;
  const color =
    score >= 70 ? "text-red-400 bg-red-500/10 border-red-500/30" :
    score >= 40 ? "text-amber-400 bg-amber-500/10 border-amber-500/30" :
                 "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${color}`}>
      {score}% risk
    </span>
  );
}

function StatCard({ label, value, color = "text-white" }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-2xl border border-nq-border/40 bg-nq-surface p-4">
      <p className={`text-2xl font-semibold ${color}`}>{value}</p>
      <p className="mt-1 text-xs text-nq-muted">{label}</p>
    </div>
  );
}

/**
 * Uncollected no-show fees — the saved-card charge failed (declined / no funds).
 * Turns a dead "failed" log into recoverable revenue: the desk can RETRY the
 * charge (the card may now have funds — a retry uses a fresh idempotency key so
 * Square re-attempts) or WAIVE it. A recovered/waived row drops off the list.
 */
function UncollectedFeesCard({
  slug,
  salonId,
  fees,
  language,
}: {
  slug: string;
  salonId: string;
  fees: UncollectedFee[];
  language: "en" | "vi";
}) {
  const [rows, setRows] = useState(fees);
  const [busy, setBusy] = useState<Record<string, "retry" | "waive" | "link" | null>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const vi = language === "vi";

  if (rows.length === 0) return null;
  const totalCents = rows.reduce((s, f) => s + f.feeCents, 0);

  async function retry(id: string) {
    setBusy((b) => ({ ...b, [id]: "retry" }));
    setNote((n) => ({ ...n, [id]: "" }));
    try {
      const r = await chargeNoShowFeeManual(slug, { salonId, bookingId: id });
      if (r.ok && r.charged) {
        setRows((rs) => rs.filter((f) => f.id !== id));
      } else {
        setNote((n) => ({
          ...n,
          [id]: vi ? "Vẫn chưa thu được — thẻ bị từ chối" : "Still declined",
        }));
      }
    } catch {
      setNote((n) => ({ ...n, [id]: vi ? "Lỗi, thử lại" : "Error, try again" }));
    } finally {
      setBusy((b) => ({ ...b, [id]: null }));
    }
  }

  async function waive(id: string) {
    setBusy((b) => ({ ...b, [id]: "waive" }));
    try {
      const r = await waiveNoShowFee(slug, { salonId, bookingId: id });
      if (r.ok) setRows((rs) => rs.filter((f) => f.id !== id));
    } catch {
      /* leave the row; desk can retry the action */
    } finally {
      setBusy((b) => ({ ...b, [id]: null }));
    }
  }

  async function sendLink(id: string) {
    setBusy((b) => ({ ...b, [id]: "link" }));
    setNote((n) => ({ ...n, [id]: "" }));
    try {
      const r = await sendNoShowFeeLink(slug, {
        salonId,
        bookingId: id,
        sendSms: true,
        language,
      });
      if (r.ok) {
        setNote((n) => ({
          ...n,
          [id]:
            r.smsSent || r.emailSent
              ? vi ? "✓ Đã gửi link cho khách" : "✓ Link sent to customer"
              : vi ? "✓ Đã tạo link (khách không có SĐT/email)" : "✓ Link created (no phone/email)",
        }));
      } else {
        setNote((n) => ({ ...n, [id]: vi ? "Không tạo được link" : "Couldn't create link" }));
      }
    } catch {
      setNote((n) => ({ ...n, [id]: vi ? "Lỗi, thử lại" : "Error, try again" }));
    } finally {
      setBusy((b) => ({ ...b, [id]: null }));
    }
  }

  return (
    <div className="mt-4 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-300/80">
          💸 {vi ? "Phí no-show chưa thu được" : "Uncollected no-show fees"}
        </p>
        <p className="text-sm font-bold tabular-nums text-amber-300">
          ${(totalCents / 100).toFixed(2)}
        </p>
      </div>
      <p className="mt-1 text-xs text-amber-200/70">
        {vi
          ? "Charge thẻ đã lưu bị từ chối. Thử thu lại (thẻ có thể đã có tiền) hoặc bỏ qua."
          : "The saved-card charge was declined. Retry (the card may now have funds) or waive."}
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((f) => {
          const b = busy[f.id] ?? null;
          return (
            <li
              key={f.id}
              data-testid={`uncollected-fee-${f.id}`}
              className="rounded-xl border border-amber-400/20 bg-nq-surface/60 p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-nq-foreground">
                    {f.clientName}
                  </p>
                  <p className="truncate text-xs text-nq-muted">
                    {f.serviceName}
                    {f.startTimeUtc ? ` · ${formatTime(f.startTimeUtc)}` : ""}
                    {f.brand || f.last4 ? ` · ${f.brand ?? "Card"} ····${f.last4 ?? ""}` : ""}
                  </p>
                </div>
                <p className="shrink-0 text-sm font-semibold tabular-nums text-amber-300">
                  ${(f.feeCents / 100).toFixed(2)}
                </p>
              </div>
              {note[f.id] ? (
                <p className="mt-1 text-[11px] text-red-400">{note[f.id]}</p>
              ) : null}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={b !== null}
                  onClick={() => void retry(f.id)}
                  data-testid={`uncollected-fee-retry-${f.id}`}
                  className="flex-1 rounded-md bg-amber-400/20 py-1.5 text-[11px] font-semibold text-amber-300 transition-colors hover:bg-amber-400/30 disabled:opacity-50"
                >
                  {b === "retry"
                    ? vi ? "Đang thu…" : "Charging…"
                    : vi ? "Thử thu lại" : "Retry charge"}
                </button>
                <button
                  type="button"
                  disabled={b !== null}
                  onClick={() => void sendLink(f.id)}
                  data-testid={`uncollected-fee-link-${f.id}`}
                  className="flex-1 rounded-md border border-nq-primary/40 py-1.5 text-[11px] font-semibold text-nq-primary transition-colors hover:bg-nq-primary/10 disabled:opacity-50"
                >
                  {b === "link"
                    ? vi ? "Đang gửi…" : "Sending…"
                    : vi ? "Gửi link khách trả" : "Send pay link"}
                </button>
                <button
                  type="button"
                  disabled={b !== null}
                  onClick={() => void waive(f.id)}
                  data-testid={`uncollected-fee-waive-${f.id}`}
                  className="flex-1 rounded-md border border-nq-border/50 py-1.5 text-[11px] font-semibold text-nq-muted transition-colors hover:text-nq-foreground disabled:opacity-50"
                >
                  {b === "waive"
                    ? vi ? "Đang bỏ…" : "Waiving…"
                    : vi ? "Bỏ qua" : "Waive"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const PERIODS = [
  { label: "7 ngày", labelEn: "7 days", days: 7 },
  { label: "30 ngày", labelEn: "30 days", days: 30 },
  { label: "90 ngày", labelEn: "90 days", days: 90 },
  { label: "Tất cả", labelEn: "All time", days: null },
] as const;

const STATUSES = [
  { key: "all",      labelVi: "Tất cả",    labelEn: "All" },
  { key: "charged",  labelVi: "✅ Đã thu",  labelEn: "✅ Charged" },
  { key: "failed",   labelVi: "❌ Thất bại",labelEn: "❌ Failed" },
  { key: "saved",    labelVi: "🔵 Chờ",     labelEn: "🔵 Pending" },
  { key: "waived",   labelVi: "🟡 Bỏ qua", labelEn: "🟡 Waived" },
] as const;

function ChargeStatusBadge({ status, error }: { status: string | null; error: string | null }) {
  if (!status) return <span className="text-xs text-nq-muted">—</span>;
  const cfg: Record<string, { label: string; cls: string }> = {
    charged:  { label: "✅ Đã thu",    cls: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" },
    failed:   { label: "❌ Thất bại",  cls: "text-red-400 bg-red-500/10 border-red-500/30" },
    saved:    { label: "🔵 Chờ thu",   cls: "text-blue-400 bg-blue-500/10 border-blue-500/30" },
    waived:   { label: "🟡 Bỏ qua",   cls: "text-amber-300 bg-amber-400/10 border-amber-400/30" },
    deferred: { label: "⬜ Deferred",  cls: "text-nq-muted bg-nq-surface border-nq-border/40" },
  };
  const c = cfg[status] ?? { label: status, cls: "text-nq-muted bg-nq-surface border-nq-border/40" };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${c.cls}`}>
      {c.label}
      {status === "failed" && error ? (
        <span className="text-red-300/70"> · {error}</span>
      ) : null}
    </span>
  );
}

function NoShowHistorySection({ slug, salonId, language }: { slug: string; salonId: string; language: "en" | "vi" }) {
  const vi = language === "vi";
  const [items, setItems] = useState<NoShowHistoryItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [days, setDays] = useState<number | null>(30);
  const [statusFilter, setStatusFilter] = useState("all");
  const [actionBusy, setActionBusy] = useState<Record<string, string | null>>({});
  const [actionNote, setActionNote] = useState<Record<string, string>>({});
  const PAGE = 20;

  const salonSlug = slug;

  async function fetchPage(newDays: number | null, newStatus: string, offset: number, append: boolean) {
    if (offset === 0) setLoading(true); else setLoadingMore(true);
    try {
      const res = await loadNoShowHistory(salonSlug, { days: newDays, status: newStatus, offset, limit: PAGE });
      if (res.ok && res.items) {
        setItems((prev) => append ? [...prev, ...res.items!] : res.items!);
        setHasMore(res.hasMore ?? false);
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  // Auto-load on mount
  useEffect(() => { void fetchPage(days, statusFilter, 0, false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handlePeriod(d: number | null) {
    setDays(d);
    setItems([]);
    void fetchPage(d, statusFilter, 0, false);
  }

  function handleStatus(s: string) {
    setStatusFilter(s);
    setItems([]);
    void fetchPage(days, s, 0, false);
  }

  async function retryCharge(id: string) {
    setActionBusy((b) => ({ ...b, [id]: "retry" }));
    setActionNote((n) => ({ ...n, [id]: "" }));
    try {
      const r = await chargeNoShowFeeManual(salonSlug, { salonId, bookingId: id });
      if (r.ok && r.charged) {
        setItems((prev) => prev.map((x) => x.id === id ? { ...x, chargeStatus: "charged", chargeError: null } : x));
        setActionNote((n) => ({ ...n, [id]: vi ? "✓ Đã thu thành công" : "✓ Charged successfully" }));
      } else {
        setActionNote((n) => ({ ...n, [id]: vi ? "Vẫn bị từ chối" : "Still declined" }));
      }
    } catch {
      setActionNote((n) => ({ ...n, [id]: vi ? "Lỗi, thử lại" : "Error, try again" }));
    } finally {
      setActionBusy((b) => ({ ...b, [id]: null }));
    }
  }

  async function waive(id: string) {
    setActionBusy((b) => ({ ...b, [id]: "waive" }));
    try {
      const r = await waiveNoShowFee(salonSlug, { salonId, bookingId: id });
      if (r.ok) {
        setItems((prev) => prev.map((x) => x.id === id ? { ...x, chargeStatus: "waived" } : x));
      }
    } finally {
      setActionBusy((b) => ({ ...b, [id]: null }));
    }
  }

  async function sendLink(id: string) {
    setActionBusy((b) => ({ ...b, [id]: "link" }));
    setActionNote((n) => ({ ...n, [id]: "" }));
    try {
      const r = await sendNoShowFeeLink(salonSlug, { salonId, bookingId: id, sendSms: true, language });
      setActionNote((n) => ({
        ...n,
        [id]: r.ok
          ? (r.smsSent || r.emailSent ? (vi ? "✓ Đã gửi link" : "✓ Link sent") : (vi ? "✓ Đã tạo link" : "✓ Link created"))
          : (vi ? "Không tạo được link" : "Couldn't create link"),
      }));
    } catch {
      setActionNote((n) => ({ ...n, [id]: vi ? "Lỗi, thử lại" : "Error, try again" }));
    } finally {
      setActionBusy((b) => ({ ...b, [id]: null }));
    }
  }

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-widest text-nq-primary">
        {vi ? "Lịch sử no-show" : "No-Show History"}
      </h2>

      {/* Period filter */}
      <div className="flex flex-wrap gap-1.5">
        {PERIODS.map((p) => (
          <button
            key={String(p.days)}
            type="button"
            onClick={() => handlePeriod(p.days)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              days === p.days
                ? "border-nq-primary/60 bg-nq-primary/15 text-nq-primary"
                : "border-nq-border/40 text-nq-muted hover:text-nq-foreground"
            }`}
          >
            {vi ? p.label : p.labelEn}
          </button>
        ))}
      </div>

      {/* Status filter */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {STATUSES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => handleStatus(s.key)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              statusFilter === s.key
                ? "border-nq-primary/60 bg-nq-primary/15 text-nq-primary"
                : "border-nq-border/40 text-nq-muted hover:text-nq-foreground"
            }`}
          >
            {vi ? s.labelVi : s.labelEn}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="mt-3">
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl bg-nq-surface/60" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-nq-border/30 bg-nq-surface/40 py-10 text-center text-sm text-nq-muted">
            {vi ? "Không có lịch no-show trong khoảng thời gian này." : "No no-shows in this period."}
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => {
              const busy = actionBusy[item.id] ?? null;
              const isFailed = item.chargeStatus === "failed";
              return (
                <li
                  key={item.id}
                  className="rounded-xl border border-nq-border/40 bg-nq-surface p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <p className="text-sm font-medium text-nq-foreground">{item.clientName}</p>
                        {item.clientPhone && (
                          <p className="text-xs text-nq-muted">{item.clientPhone}</p>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-nq-muted">
                        {item.serviceName}
                        {item.staffName !== "—" ? ` · ${item.staffName}` : ""}
                        {item.startTimeUtc ? ` · ${formatTime(item.startTimeUtc)}` : ""}
                      </p>
                      {(item.cardBrand || item.cardLast4) && (
                        <p className="mt-0.5 text-xs text-nq-muted">
                          {item.cardBrand ?? "Card"} ····{item.cardLast4 ?? ""}
                          {item.chargeAttempts > 0 ? ` · ${item.chargeAttempts}× tried` : ""}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {item.feeCents != null && item.feeCents > 0 && (
                        <p className="text-sm font-semibold tabular-nums text-nq-foreground">
                          ${(item.feeCents / 100).toFixed(2)}
                        </p>
                      )}
                      <ChargeStatusBadge status={item.chargeStatus} error={item.chargeError} />
                    </div>
                  </div>

                  {actionNote[item.id] && (
                    <p className="mt-1.5 text-[11px] text-nq-primary">{actionNote[item.id]}</p>
                  )}

                  {isFailed && (
                    <div className="mt-2 flex gap-1.5">
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void retryCharge(item.id)}
                        className="flex-1 rounded-md bg-red-500/15 py-1.5 text-[11px] font-semibold text-red-300 transition-colors hover:bg-red-500/25 disabled:opacity-50"
                      >
                        {busy === "retry" ? (vi ? "Đang thu…" : "Charging…") : (vi ? "Thử thu lại" : "Retry")}
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void sendLink(item.id)}
                        className="flex-1 rounded-md border border-nq-primary/40 py-1.5 text-[11px] font-semibold text-nq-primary transition-colors hover:bg-nq-primary/10 disabled:opacity-50"
                      >
                        {busy === "link" ? (vi ? "Đang gửi…" : "Sending…") : (vi ? "Gửi link" : "Send link")}
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void waive(item.id)}
                        className="flex-1 rounded-md border border-nq-border/50 py-1.5 text-[11px] font-semibold text-nq-muted transition-colors hover:text-nq-foreground disabled:opacity-50"
                      >
                        {busy === "waive" ? (vi ? "Đang bỏ…" : "Waiving…") : (vi ? "Bỏ qua" : "Waive")}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {hasMore && !loading && (
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void fetchPage(days, statusFilter, items.length, true)}
            className="mt-3 w-full rounded-xl border border-nq-border/40 py-2.5 text-xs font-medium text-nq-muted transition-colors hover:text-nq-foreground disabled:opacity-50"
          >
            {loadingMore ? (vi ? "Đang tải…" : "Loading…") : (vi ? "Xem thêm" : "Load more")}
          </button>
        )}
      </div>
    </section>
  );
}

export function NoShowProtectionHub({
  slug,
  salonId,
  isOwner,
  autoBookEnabled: initialAutoBook,
  remindersEnabled: initialReminders,
  reminder24hEnabled: initial24h,
  reminder3hEnabled: initial3h,
  smsRemindersEnabled: initialSms,
  depositHighValueCents: initialThreshold,
  depositPctNoShow: initialPctNoShow,
  depositPctHighValue: initialPctHighValue,
  depositPctNewCustomer: initialPctNewCustomer,
  depositEnabled: initialDepositEnabled,
  depositHoldGraceMinutes: initialGrace,
  cancellationPolicyEn: initialPolicyEn,
  cancellationPolicyVi: initialPolicyVi,
  healthAckEffective: initialHealthAck,
  emailLinksEnabled: initialEmailLinks,
  connectHasAccount,
  connectChargesEnabled,
  connectDetailsSubmitted,
  paymentProvider: initialProvider,
  noshowProtectionEnabled: initialNoshowEnabled,
  noshowGroupWholeParty: initialWholeParty,
  noshowRequireNewCustomer: initialReqNew,
  noshowRequirePriorNoshow: initialReqPrior,
  noshowMinNoshowCount: initialMinCount,
  noshowRequireHighRisk: initialReqRisk,
  noshowDepositEscalationThreshold: initialEscalation,
  noshowFeePercent: initialNoshowPct,
  noshowRiskThreshold: initialNoshowThreshold,
  selfCancelFeeEnabled: initialSelfCancelFee,
  selfCancelWindowHours: initialSelfCancelWindow,
  selfCancelFeePercent: initialSelfCancelPct,
  summary,
  unconfirmed,
  waitlist,
  uncollectedFees,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Bilingual copy for the waitlist section (shares the keys the Receptionist
  // Center waitlist panel uses).
  const { language } = useUserLanguage();
  const wlCopy = getUserMessages(language).receptionist.waitlist;
  const [autoBook, setAutoBook] = useState(initialAutoBook);
  const [remindersEnabled, setRemindersEnabled] = useState(initialReminders);
  const [reminder24h, setReminder24h] = useState(initial24h);
  const [reminder3h, setReminder3h] = useState(initial3h);
  const [smsReminders, setSmsReminders] = useState(initialSms);
  const [emailLinks, setEmailLinks] = useState(initialEmailLinks);
  const [threshold, setThreshold] = useState(String(Math.round(initialThreshold / 100)));
  const [pctNoShow, setPctNoShow] = useState(String(initialPctNoShow));
  const [pctHighValue, setPctHighValue] = useState(String(initialPctHighValue));
  const [pctNewCustomer, setPctNewCustomer] = useState(String(initialPctNewCustomer));
  const [depositEnabled, setDepositEnabled] = useState(initialDepositEnabled);
  const [policyEn, setPolicyEn] = useState(initialPolicyEn);
  const [policyVi, setPolicyVi] = useState(initialPolicyVi);
  const [grace, setGrace] = useState(String(initialGrace));
  const [healthAck, setHealthAck] = useState(initialHealthAck);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [waivedIds, setWaivedIds] = useState<Set<string>>(new Set());
  // No-show card-on-file policy (provider-agnostic) + provider choice.
  const [provider, setProvider] = useState<"square" | "stripe">(
    initialProvider ?? "square",
  );
  const [noshowEnabled, setNoshowEnabled] = useState(initialNoshowEnabled);
  const [wholeParty, setWholeParty] = useState(initialWholeParty);
  const [reqNew, setReqNew] = useState(initialReqNew);
  const [reqPrior, setReqPrior] = useState(initialReqPrior);
  const [minCount, setMinCount] = useState(String(initialMinCount));
  const [reqRisk, setReqRisk] = useState(initialReqRisk);
  // Escalation: ON when a threshold is set. The number input holds the count.
  const [escalationOn, setEscalationOn] = useState(initialEscalation != null);
  const [escalationThreshold, setEscalationThreshold] = useState(
    String(initialEscalation ?? 2),
  );
  const [noshowPct, setNoshowPct] = useState(String(initialNoshowPct));
  const [noshowThreshold, setNoshowThreshold] = useState(String(initialNoshowThreshold));
  const [selfCancelFee, setSelfCancelFee] = useState(initialSelfCancelFee);
  const [selfCancelWindow, setSelfCancelWindow] = useState(String(initialSelfCancelWindow));
  const [selfCancelPct, setSelfCancelPct] = useState(
    initialSelfCancelPct == null ? "" : String(initialSelfCancelPct),
  );
  const [cardSaveMsg, setCardSaveMsg] = useState<string | null>(null);

  function saveCardSettings() {
    startTransition(async () => {
      const r = await updateNoShowCardSettings(slug, {
        payment_provider: provider,
        noshow_protection_enabled: noshowEnabled,
        noshow_fee_percent: parseInt(noshowPct, 10) || 0,
        noshow_risk_threshold: parseInt(noshowThreshold, 10) || 0,
        noshow_group_whole_party: wholeParty,
        noshow_require_new_customer: reqNew,
        noshow_require_prior_noshow: reqPrior,
        noshow_min_noshow_count: parseInt(minCount, 10) || 1,
        noshow_require_high_risk: reqRisk,
        noshow_deposit_escalation_threshold: escalationOn
          ? parseInt(escalationThreshold, 10) || 2
          : null,
        self_cancel_fee_enabled: selfCancelFee,
        self_cancel_window_hours: parseInt(selfCancelWindow, 10) || 24,
        self_cancel_fee_percent:
          selfCancelPct.trim() === "" ? null : parseInt(selfCancelPct, 10) || 0,
      });
      setCardSaveMsg(r.ok ? "Đã lưu" : (r.error ?? "Lỗi"));
      setTimeout(() => setCardSaveMsg(null), 3000);
      router.refresh();
    });
  }

  function toggleAutoBook(next: boolean) {
    setAutoBook(next);
    startTransition(async () => {
      const r = await updateWaitlistAutoBook(slug, next);
      if (!r.ok) setAutoBook(!next); // revert on failure
      router.refresh();
    });
  }

  function toggleReminders(next: boolean) {
    setRemindersEnabled(next);
    startTransition(async () => {
      await updateRemindersEnabled(slug, next);
      router.refresh();
    });
  }

  function saveSettings() {
    startTransition(async () => {
      const cents = Math.round(parseFloat(threshold) * 100);
      await updateReminderSettings(slug, {
        reminder_24h_enabled: reminder24h,
        reminder_3h_enabled: reminder3h,
        sms_reminders_enabled: smsReminders,
        email_links_enabled: emailLinks,
        deposit_high_value_cents: isNaN(cents) ? 10000 : cents,
        deposit_pct_no_show: parseInt(pctNoShow, 10),
        deposit_pct_high_value: parseInt(pctHighValue, 10),
        deposit_pct_new_customer: parseInt(pctNewCustomer, 10),
        deposit_enabled: depositEnabled,
        deposit_hold_grace_minutes: parseInt(grace, 10) || 30,
        cancellation_policy: { en: policyEn, vi: policyVi },
        health_ack_required: healthAck,
      });
      setSaveMsg("Settings saved");
      setTimeout(() => setSaveMsg(null), 3000);
      router.refresh();
    });
  }

  function handleWaiveDeposit(bookingId: string) {
    startTransition(async () => {
      const r = await waiveBookingDeposit(slug, bookingId);
      if (r.ok) {
        setWaivedIds((prev) => new Set([...prev, bookingId]));
      }
    });
  }

  return (
    <ResponsiveShell>
      <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-8 pt-4 sm:pt-6">
        <SetupBackNav slug={slug} title="No-Show Protection" />

        {/* Revenue recovered — the payoff of card-on-file protection. */}
        <div className="mt-4 rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-300/80">
            💰 No-show fees recovered / Phí no-show đã thu
          </p>
          <p className="mt-1 text-3xl font-bold tabular-nums text-emerald-300">
            ${(summary.noShowFeesRecoveredCents / 100).toFixed(2)}
          </p>
          <p className="mt-1 text-xs text-emerald-200/70">
            {summary.noShowFeesChargedCount} charged · {summary.noShowFeesWaivedCount} waived ·{" "}
            {summary.cardsOnFileCount} card{summary.cardsOnFileCount === 1 ? "" : "s"} on file protecting upcoming bookings
          </p>
        </div>

        {/* Uncollected fees — failed charges the salon can recover. */}
        <UncollectedFeesCard
          slug={slug}
          salonId={salonId}
          fees={uncollectedFees}
          language={language}
        />

        {/* Summary cards */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="Unconfirmed (48h)" value={summary.unconfirmedCount} />
          <StatCard label="High risk" value={summary.highRiskCount} color="text-red-400" />
          <StatCard label="Deposit required" value={summary.depositRequiredCount} color="text-amber-400" />
          <StatCard label="Cancelled today" value={summary.cancelledTodayCount} />
          <StatCard label="Waitlist waiting" value={summary.waitingWaitlistCount} color="text-nq-primary" />
          <StatCard label="Recovered this week" value={summary.recoveredThisWeekCount} color="text-emerald-400" />
        </div>

        {/* Stripe Connect — owner only (deposits go to the salon's own account) */}
        {isOwner && (
          <StripeConnectCard
            slug={slug}
            initialHasAccount={connectHasAccount}
            initialChargesEnabled={connectChargesEnabled}
            initialDetailsSubmitted={connectDetailsSubmitted}
          />
        )}

        {/* Payment provider + no-show card-on-file policy — owner only */}
        {isOwner && (
          <section className="mt-6 rounded-2xl border border-nq-border/40 bg-nq-surface p-5">
            <h2 className="text-sm font-semibold text-nq-text">
              Lưu thẻ khi đặt (chống no-show)
            </h2>
            <p className="mt-1 text-xs text-nq-muted">
              Khách lần đầu &amp; khách rủi ro cao phải lưu thẻ (không trừ tiền).
              No-show thì nhân viên chọn thu hay bỏ qua.
            </p>

            <label className="mt-4 block text-xs font-medium text-nq-muted">
              Cổng thanh toán
            </label>
            <div className="mt-1 flex gap-2">
              {(["square", "stripe"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProvider(p)}
                  className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                    provider === p
                      ? "border-nq-primary bg-nq-primary/15 text-nq-primary"
                      : "border-nq-border/50 text-nq-muted hover:border-nq-primary/40"
                  }`}
                >
                  {p === "square" ? "Square (nhập thẻ)" : "Stripe (1-chạm Apple/Google Pay)"}
                </button>
              ))}
            </div>

            <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-nq-text">
              <input
                type="checkbox"
                checked={noshowEnabled}
                onChange={(e) => setNoshowEnabled(e.target.checked)}
                className="h-4 w-4 accent-nq-primary"
              />
              Bật yêu cầu lưu thẻ no-show
            </label>
            <p className="mt-1 text-xs text-nq-muted">
              {noshowEnabled ? (
                <>
                  <span className="font-medium text-nq-text">Đang BẬT:</span> khách rủi ro
                  được mời lưu thẻ khi đặt. <span className="text-nq-text">Không thu tiền
                  trước</span> — chỉ trừ phí no-show nếu khách không đến. Đây là cách bảo vệ
                  ít cản trở nhất.
                </>
              ) : (
                <>
                  <span className="font-medium text-nq-text">Đang TẮT:</span> không mời lưu
                  thẻ → booking <span className="text-nq-text">không có lớp bảo vệ no-show
                  bằng thẻ</span>.
                </>
              )}
            </p>

            {noshowEnabled ? (
              <div className="mt-4 rounded-xl border border-nq-border/40 bg-nq-bg/40 p-3">
                <p className="text-xs font-medium uppercase tracking-widest text-nq-muted">
                  Khi nào yêu cầu lưu thẻ? · When to ask for a card
                </p>
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-nq-text">
                  <input
                    type="checkbox"
                    data-testid="rule-new-customer"
                    checked={reqNew}
                    onChange={(e) => setReqNew(e.target.checked)}
                    className="h-4 w-4 accent-nq-primary"
                  />
                  <span>Khách mới (lần đầu) · First-time customers</span>
                </label>
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-nq-text">
                  <input
                    type="checkbox"
                    data-testid="rule-prior-noshow"
                    checked={reqPrior}
                    onChange={(e) => setReqPrior(e.target.checked)}
                    className="h-4 w-4 accent-nq-primary"
                  />
                  <span className="flex flex-wrap items-center gap-1">
                    Khách từng no-show — sau
                    <input
                      type="number"
                      min="1"
                      max="20"
                      data-testid="rule-min-noshow-count"
                      value={minCount}
                      disabled={!reqPrior}
                      onChange={(e) => setMinCount(e.target.value)}
                      className="w-14 rounded-lg border border-nq-border/40 bg-nq-bg px-2 py-1 text-sm text-nq-text focus:outline-none focus:border-nq-primary/50 disabled:opacity-40"
                    />
                    lần · after N no-shows
                  </span>
                </label>
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-nq-text">
                  <input
                    type="checkbox"
                    data-testid="rule-high-risk"
                    checked={reqRisk}
                    onChange={(e) => setReqRisk(e.target.checked)}
                    className="h-4 w-4 accent-nq-primary"
                  />
                  <span>Booking rủi ro cao (AI) · High-risk bookings</span>
                </label>
                <p className="mt-2 text-xs text-nq-muted">
                  {reqNew || reqPrior || reqRisk
                    ? "Chỉ những nhóm được tick mới bị hỏi lưu thẻ. Khách quen sạch lịch sử không bị làm phiền."
                    : "⚠️ Tắt hết → KHÔNG ai bị hỏi lưu thẻ (không có bảo vệ no-show)."}
                </p>
              </div>
            ) : null}

            {noshowEnabled ? (
              <>
                <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-nq-text">
                  <input
                    type="checkbox"
                    data-testid="noshow-whole-party-toggle"
                    checked={wholeParty}
                    onChange={(e) => setWholeParty(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-nq-primary"
                  />
                  <span>Một thẻ giữ cả nhóm / Whole-party deposit</span>
                </label>
                <p className="ml-6 mt-1 text-xs text-nq-muted">
                  {wholeParty ? (
                    <>
                      <span className="font-medium text-nq-text">Đang BẬT:</span> với booking
                      nhóm, thẻ của người tổ chức giữ phí no-show cho{" "}
                      <span className="text-nq-text">cả nhóm</span> (vd nhóm $150 → giữ $30 cho
                      cả party). Bảo vệ mạnh khi cả nhóm bùng, chỉ cần 1 thẻ.
                    </>
                  ) : (
                    <>
                      <span className="font-medium text-nq-text">Đang TẮT:</span> chỉ giữ phí
                      của <span className="text-nq-text">riêng người tổ chức</span> — nếu cả
                      nhóm bùng, tiệm chỉ thu được 1 suất.
                    </>
                  )}
                </p>

                {/* Auto-escalation: chronic no-show → upfront pay-to-confirm deposit */}
                <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-nq-text">
                  <input
                    type="checkbox"
                    data-testid="noshow-escalation-toggle"
                    checked={escalationOn}
                    onChange={(e) => setEscalationOn(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-nq-primary"
                  />
                  <span>Khách hay bùng → buộc cọc trước / Escalate to deposit</span>
                </label>
                {escalationOn ? (
                  <div className="ml-6 mt-1 flex items-center gap-2">
                    <span className="text-xs text-nq-muted">Sau</span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={escalationThreshold}
                      onChange={(e) => setEscalationThreshold(e.target.value)}
                      data-testid="noshow-escalation-threshold"
                      className="w-16 rounded-lg border border-nq-border/50 bg-nq-bg px-2 py-1 text-sm text-nq-text"
                    />
                    <span className="text-xs text-nq-muted">lần no-show</span>
                  </div>
                ) : null}
                <p className="ml-6 mt-1 text-xs text-nq-muted">
                  {escalationOn ? (
                    <>
                      <span className="font-medium text-nq-text">Đang BẬT:</span> khách đạt số
                      lần no-show này phải <span className="text-nq-text">trả cọc trước</span>{" "}
                      (giữ chỗ + gửi link; không trả thì tự huỷ) thay vì chỉ giữ thẻ → thu chắc
                      ở nhóm rủi ro cao.
                    </>
                  ) : (
                    <>
                      <span className="font-medium text-nq-text">Đang TẮT:</span> khách hay bùng
                      vẫn chỉ bị giữ thẻ (charge sau, có thể hụt). Bật để buộc cọc trước.
                    </>
                  )}
                </p>
              </>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-4">
              <div>
                <label className="block text-xs text-nq-muted">Phí no-show (%)</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={noshowPct}
                  onChange={(e) => setNoshowPct(e.target.value)}
                  className="mt-1 w-24 rounded-lg border border-nq-border/50 bg-nq-bg px-2 py-1 text-sm text-nq-text"
                />
              </div>
              <div>
                <label className="block text-xs text-nq-muted">
                  Ngưỡng rủi ro (khách quen mới phải lưu)
                </label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={noshowThreshold}
                  onChange={(e) => setNoshowThreshold(e.target.value)}
                  className="mt-1 w-24 rounded-lg border border-nq-border/50 bg-nq-bg px-2 py-1 text-sm text-nq-text"
                />
              </div>
            </div>

            {/* Late self-cancel fee — charge the same % when a customer cancels
                close to the appointment via the self-serve link. */}
            <div className="mt-4 rounded-xl border border-nq-border/40 bg-nq-bg/40 p-3">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={selfCancelFee}
                  onChange={(e) => setSelfCancelFee(e.target.checked)}
                  data-testid="self-cancel-fee-toggle"
                  className="mt-0.5 h-4 w-4 accent-nq-primary"
                />
                <span className="text-sm text-nq-text">
                  Tính phí khi khách tự huỷ trễ
                  <span className="block text-xs text-nq-muted">
                    Charge the no-show fee on a late self-cancellation
                  </span>
                </span>
              </label>
              {selfCancelFee ? (
                <div className="ml-6 mt-2 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-nq-muted">Cửa sổ huỷ — huỷ trong vòng</span>
                    <input
                      type="number"
                      min={1}
                      max={168}
                      value={selfCancelWindow}
                      onChange={(e) => setSelfCancelWindow(e.target.value)}
                      data-testid="self-cancel-window-hours"
                      className="w-16 rounded-lg border border-nq-border/50 bg-nq-bg px-2 py-1 text-sm text-nq-text"
                    />
                    <span className="text-xs text-nq-muted">giờ trước hẹn → tính phí</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-nq-muted">Phí huỷ trễ (%)</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={selfCancelPct}
                      placeholder={`= ${noshowPct}`}
                      onChange={(e) => setSelfCancelPct(e.target.value)}
                      data-testid="self-cancel-fee-percent"
                      className="w-20 rounded-lg border border-nq-border/50 bg-nq-bg px-2 py-1 text-sm text-nq-text"
                    />
                    <span className="text-xs text-nq-muted">
                      để trống = giống phí no-show ({noshowPct}%)
                    </span>
                  </div>
                </div>
              ) : null}
              <p className="ml-6 mt-2 text-xs text-nq-muted">
                {selfCancelFee ? (
                  <>
                    <span className="font-medium text-nq-text">Đang BẬT:</span> khách huỷ qua
                    link trong cửa sổ này, nếu đã lưu thẻ + đồng ý, sẽ bị tính phí{" "}
                    {selfCancelPct.trim() === "" ? noshowPct : selfCancelPct}%. Huỷ sớm hơn
                    thì miễn phí.{" "}
                    <span className="text-emerald-400">
                      💚 Fair Cancel: nếu waitlist/khách khác lấp được đúng chỗ trống trước
                      giờ hẹn, phí sẽ được <span className="font-medium">tự động hoàn</span>{" "}
                      — tiệm không mất chỗ thì khách không mất tiền.
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-medium text-nq-text">Đang TẮT:</span> khách tự huỷ
                    lúc nào cũng miễn phí (có thể né phí no-show bằng cách huỷ sát giờ).
                  </>
                )}
              </p>
            </div>

            <button
              onClick={saveCardSettings}
              disabled={isPending}
              className="mt-4 rounded-xl bg-nq-primary px-4 py-2 text-xs font-semibold text-black transition hover:bg-nq-primary/90 disabled:opacity-50"
            >
              {isPending ? "Đang lưu…" : "Lưu"}
            </button>
            {cardSaveMsg && (
              <p className="mt-2 text-xs text-emerald-400">{cardSaveMsg}</p>
            )}
          </section>
        )}

        {/* Auto-book waitlist claims — owner only. When ON, a freed slot the
            customer claims via SMS becomes a real booking with no staff input. */}
        {isOwner && (
          <section className="mt-6 rounded-2xl border border-nq-primary/30 bg-nq-surface p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-nq-text">
                  {language === "vi"
                    ? "Tự động đặt lịch khi khách giành chỗ"
                    : "Auto-book waitlist claims"}
                </h2>
                <p className="mt-0.5 text-xs text-nq-muted">
                  {language === "vi"
                    ? "Khi có chỗ trống, khách trong danh sách chờ bấm link là tự tạo hẹn (đúng thợ + giờ) — nhân viên không cần thao tác."
                    : "When a slot frees up, a waitlisted customer who taps the SMS link is booked automatically (right tech + time) — no staff action needed."}
                </p>
              </div>
              <button
                onClick={() => toggleAutoBook(!autoBook)}
                disabled={isPending}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${autoBook ? "bg-nq-primary" : "bg-nq-border"}`}
                aria-pressed={autoBook}
                aria-label={
                  language === "vi" ? "Bật/tắt tự động đặt lịch" : "Toggle auto-book"
                }
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${autoBook ? "translate-x-5" : "translate-x-0.5"}`} />
              </button>
            </div>
            <p className="mt-2 text-xs text-nq-muted">
              {autoBook
                ? language === "vi"
                  ? "✅ Đang bật — hẹn tự tạo, không bao giờ trùng 2 khách 1 ghế."
                  : "✅ On — bookings are created automatically; never double-books."
                : language === "vi"
                  ? "Đang tắt — nhân viên tự bấm “Tạo lịch” khi khách giành chỗ."
                  : "Off — staff create the booking manually when a customer claims."}
            </p>
          </section>
        )}

        {/* Reminder settings — owner only */}
        {isOwner && (
          <section className="mt-6 rounded-2xl border border-nq-border/40 bg-nq-surface p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-nq-text">Automated Reminders</h2>
                <p className="mt-0.5 text-xs text-nq-muted">Send email reminders before appointments</p>
              </div>
              <button
                onClick={() => toggleReminders(!remindersEnabled)}
                disabled={!isOwner || isPending}
                className={`relative h-6 w-11 rounded-full transition ${remindersEnabled ? "bg-nq-primary" : "bg-nq-border"}`}
                aria-pressed={remindersEnabled}
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${remindersEnabled ? "translate-x-5" : "translate-x-0.5"}`} />
              </button>
            </div>

            {remindersEnabled && (
              <div className="mt-4 space-y-3 border-t border-nq-border/30 pt-4">
                <p className="text-xs font-medium uppercase tracking-widest text-nq-muted">Email</p>
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={reminder24h}
                    onChange={(e) => setReminder24h(e.target.checked)}
                    className="h-4 w-4 rounded accent-nq-primary"
                  />
                  <span className="text-sm text-nq-text">24-hour reminder</span>
                </label>
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={reminder3h}
                    onChange={(e) => setReminder3h(e.target.checked)}
                    className="h-4 w-4 rounded accent-nq-primary"
                  />
                  <span className="text-sm text-nq-text">3-hour reminder</span>
                </label>
                <p className="mt-1 text-xs font-medium uppercase tracking-widest text-nq-muted">SMS</p>
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={smsReminders}
                    onChange={(e) => setSmsReminders(e.target.checked)}
                    className="h-4 w-4 rounded accent-nq-primary"
                  />
                  <span className="text-sm text-nq-text">
                    SMS reminders
                    <span className="ml-2 text-xs text-nq-muted">(requires Twilio phone number)</span>
                  </span>
                </label>
                <p className="mt-1 text-xs font-medium uppercase tracking-widest text-nq-muted">Email</p>
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    data-testid="email-links-toggle"
                    checked={emailLinks}
                    onChange={(e) => setEmailLinks(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded accent-nq-primary"
                  />
                  <span className="text-sm text-nq-text">
                    Cũng gửi link qua email · Also email links
                    <span className="mt-0.5 block text-xs text-nq-muted">
                      Link lưu thẻ / cọc / mời chờ chỗ được gửi kèm email khi có địa chỉ — chống lỗi
                      SMS gửi link ở Mỹ. Nên để bật.
                    </span>
                  </span>
                </label>
                <div className="flex items-center gap-3">
                  <label className="text-sm text-nq-text whitespace-nowrap">High-value threshold ($)</label>
                  <input
                    type="number"
                    min="0"
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    className="w-24 rounded-lg border border-nq-border/40 bg-nq-bg px-3 py-1.5 text-sm text-nq-text focus:outline-none focus:border-nq-primary/50"
                  />
                </div>
                {/* Master ON/OFF for Square deposits + the pay-to-confirm grace
                    window. Both admin-set (no hardcode). */}
                <label className="mt-3 flex items-center gap-2 text-sm text-nq-text">
                  <input
                    type="checkbox"
                    data-testid="deposit-enabled-toggle"
                    checked={depositEnabled}
                    onChange={(e) => setDepositEnabled(e.target.checked)}
                    className="h-4 w-4 accent-nq-primary"
                  />
                  <span>Bật thu cọc (Square) / Enable deposits</span>
                </label>
                <p className="ml-6 mt-1 text-xs text-nq-muted">
                  {depositEnabled ? (
                    <>
                      <span className="font-medium text-nq-text">Đang BẬT:</span> khách rủi
                      ro (mới / dịch vụ đắt / từng vắng) bị yêu cầu <span className="text-nq-text">
                      trả trước một phần</span> để giữ chỗ. Nếu khách đã lưu thẻ thì tự bỏ cọc
                      (không đòi 2 lần). Lưu ý: nhiều khách ngại trả trước.
                    </>
                  ) : (
                    <>
                      <span className="font-medium text-nq-text">Đang TẮT:</span> không yêu
                      cầu cọc nữa — booking mới <span className="text-nq-text">không bị gắn cọc</span>.
                      Tiệm dựa hoàn toàn vào Lưu thẻ ở trên để chống no-show.
                    </>
                  )}
                </p>
                <label className="mt-1 flex items-center gap-2 text-sm text-nq-text">
                  <span className="whitespace-nowrap text-xs text-nq-muted">
                    Giữ chỗ chờ cọc (phút) / Hold grace
                  </span>
                  <input
                    type="number"
                    min="5"
                    max="1440"
                    data-testid="deposit-grace-input"
                    value={grace}
                    onChange={(e) => setGrace(e.target.value)}
                    className="ml-auto w-20 rounded-lg border border-nq-border/40 bg-nq-bg px-2 py-1.5 text-sm text-nq-text focus:outline-none focus:border-nq-primary/50"
                  />
                </label>
                {/* Deposit % per trigger — de-hardcoded; charged on the salon's
                    Stripe (Phase 2). 0 = no deposit for that trigger. */}
                <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {([
                    ["Vắng trước đó", pctNoShow, setPctNoShow],
                    ["Dịch vụ giá cao", pctHighValue, setPctHighValue],
                    ["Khách mới", pctNewCustomer, setPctNewCustomer],
                  ] as const).map(([label, val, setter]) => (
                    <label key={label} className="flex items-center gap-2 text-sm text-nq-text">
                      <span className="whitespace-nowrap text-xs text-nq-muted">{label}</span>
                      <span className="ml-auto flex items-center gap-1">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={val}
                          onChange={(e) => setter(e.target.value)}
                          className="w-16 rounded-lg border border-nq-border/40 bg-nq-bg px-2 py-1.5 text-sm text-nq-text focus:outline-none focus:border-nq-primary/50"
                        />
                        <span className="text-xs text-nq-muted">%</span>
                      </span>
                    </label>
                  ))}
                </div>

                {/* Cancellation / No-Show / Deposit policy — admin-editable,
                    bilingual, shown to customers + linked from the confirmation
                    email. De-hardcoded: blank → a built-in default is used. */}
                <div className="mt-4 rounded-xl border border-nq-border/30 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-nq-text">
                      Chính sách huỷ / vắng mặt / cọc · Cancellation policy
                    </p>
                    <a
                      href={`/${slug}/policy`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-semibold text-nq-primary underline"
                    >
                      Xem trang / View →
                    </a>
                  </div>
                  <p className="mt-1 text-xs text-nq-muted">
                    Khách thấy ở trang chính sách + email + lúc đồng ý. Để trống = dùng mẫu mặc định.
                  </p>
                  <label className="mt-2 block text-xs text-nq-muted">English</label>
                  <textarea
                    data-testid="policy-en"
                    rows={6}
                    value={policyEn}
                    onChange={(e) => setPolicyEn(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-nq-border/40 bg-nq-bg px-3 py-2 text-sm text-nq-text focus:outline-none focus:border-nq-primary/50"
                  />
                  <label className="mt-2 block text-xs text-nq-muted">Tiếng Việt</label>
                  <textarea
                    data-testid="policy-vi"
                    rows={6}
                    value={policyVi}
                    onChange={(e) => setPolicyVi(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-nq-border/40 bg-nq-bg px-3 py-2 text-sm text-nq-text focus:outline-none focus:border-nq-primary/50"
                  />
                </div>

                {/* Mandatory health-acknowledgment tick at booking (pregnancy /
                    injuries / conditions) — duty-of-care for body/treatment
                    services. Defaults ON for massage/head spa/facial/waxing. */}
                <label className="mt-3 flex items-start gap-2 text-sm text-nq-text">
                  <input
                    type="checkbox"
                    data-testid="health-ack-toggle"
                    checked={healthAck}
                    onChange={(e) => setHealthAck(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-nq-primary"
                  />
                  <span>
                    Bắt khách xác nhận sức khoẻ (mang thai/chấn thương) khi đặt · Require health
                    acknowledgment at booking
                  </span>
                </label>

                <button
                  onClick={saveSettings}
                  disabled={isPending}
                  className="mt-2 rounded-xl bg-nq-primary px-4 py-2 text-xs font-semibold text-black transition hover:bg-nq-primary/90 disabled:opacity-50"
                >
                  {isPending ? "Saving…" : "Save Settings"}
                </button>
                {saveMsg && <p className="text-xs text-emerald-400">{saveMsg}</p>}
              </div>
            )}
          </section>
        )}

        {/* Upcoming unconfirmed bookings */}
        {unconfirmed.length > 0 && (
          <section className="mt-6">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-widest text-nq-primary">
              Upcoming — Not Confirmed
            </h2>
            <div className="space-y-2">
              {unconfirmed.map((b) => (
                <div
                  key={b.id}
                  className="flex items-start justify-between rounded-xl border border-nq-border/40 bg-nq-surface p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-nq-text">{b.clientName}</p>
                    <p className="text-xs text-nq-muted">{b.serviceName} · {b.staffName}</p>
                    <p className="text-xs text-nq-muted">{formatTime(b.startTimeUtc)}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <RiskBadge score={b.riskScore} />
                      {b.depositStatus === "required" && !waivedIds.has(b.id) && (
                        <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400">
                          Deposit required
                        </span>
                      )}
                      {(b.depositStatus === "waived" || waivedIds.has(b.id)) && (
                        <span className="rounded-full border border-nq-border/30 px-2 py-0.5 text-xs text-nq-muted">
                          Deposit waived
                        </span>
                      )}
                    </div>
                  </div>
                  {isOwner && b.depositStatus === "required" && !waivedIds.has(b.id) && (
                    <button
                      onClick={() => handleWaiveDeposit(b.id)}
                      disabled={isPending}
                      className="ml-3 shrink-0 rounded-lg border border-nq-border/40 px-2 py-1 text-xs text-nq-muted transition hover:text-nq-text disabled:opacity-50"
                    >
                      Waive
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Waitlist */}
        {waitlist.length > 0 && (
          <section className="mt-6">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-widest text-nq-primary">
              {wlCopy.title}
            </h2>
            <div className="space-y-2">
              {waitlist.map((w) => (
                <div
                  key={w.id}
                  className="flex items-center justify-between rounded-xl border border-nq-border/40 bg-nq-surface p-3"
                >
                  <div>
                    <p className="text-sm font-medium text-nq-text">{w.clientName}</p>
                    <p className="text-xs text-nq-muted">{w.serviceName} · {w.bookingDate}</p>
                  </div>
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                    w.status === "notified"
                      ? "border-nq-primary/30 bg-nq-primary/10 text-nq-primary"
                      : "border-nq-border/30 text-nq-muted"
                  }`}>
                    {w.status === "notified"
                      ? wlCopy.invited
                      : wlCopy.statusWaiting}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {unconfirmed.length === 0 && waitlist.length === 0 && (
          <div className="mt-6 text-center text-sm text-nq-muted">
            <p>All clear — no unconfirmed bookings in the next 48 hours.</p>
          </div>
        )}

        {/* No-show history — always visible, self-loads */}
        <NoShowHistorySection slug={slug} salonId={salonId} language={language} />
      </MobileStack>
    </ResponsiveShell>
  );
}
