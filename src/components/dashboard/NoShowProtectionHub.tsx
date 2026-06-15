"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  updateRemindersEnabled,
  updateReminderSettings,
  updateNoShowCardSettings,
  waiveBookingDeposit,
} from "@/shared/noshow/noShowDashboardActions";
import type {
  NoShowSummary,
  UnconfirmedBooking,
  WaitlistOpportunity,
} from "@/shared/noshow/noShowDashboardActions";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { MobileStack } from "@/components/layout/MobileStack";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { StripeConnectCard } from "@/components/dashboard/StripeConnectCard";

type Props = {
  slug: string;
  isOwner: boolean;
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
  connectHasAccount: boolean;
  connectChargesEnabled: boolean;
  connectDetailsSubmitted: boolean;
  paymentProvider: "square" | "stripe" | null;
  noshowProtectionEnabled: boolean;
  noshowFeePercent: number;
  noshowRiskThreshold: number;
  summary: NoShowSummary;
  unconfirmed: UnconfirmedBooking[];
  waitlist: WaitlistOpportunity[];
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

export function NoShowProtectionHub({
  slug,
  isOwner,
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
  connectHasAccount,
  connectChargesEnabled,
  connectDetailsSubmitted,
  paymentProvider: initialProvider,
  noshowProtectionEnabled: initialNoshowEnabled,
  noshowFeePercent: initialNoshowPct,
  noshowRiskThreshold: initialNoshowThreshold,
  summary,
  unconfirmed,
  waitlist,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [remindersEnabled, setRemindersEnabled] = useState(initialReminders);
  const [reminder24h, setReminder24h] = useState(initial24h);
  const [reminder3h, setReminder3h] = useState(initial3h);
  const [smsReminders, setSmsReminders] = useState(initialSms);
  const [threshold, setThreshold] = useState(String(Math.round(initialThreshold / 100)));
  const [pctNoShow, setPctNoShow] = useState(String(initialPctNoShow));
  const [pctHighValue, setPctHighValue] = useState(String(initialPctHighValue));
  const [pctNewCustomer, setPctNewCustomer] = useState(String(initialPctNewCustomer));
  const [depositEnabled, setDepositEnabled] = useState(initialDepositEnabled);
  const [grace, setGrace] = useState(String(initialGrace));
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [waivedIds, setWaivedIds] = useState<Set<string>>(new Set());
  // No-show card-on-file policy (provider-agnostic) + provider choice.
  const [provider, setProvider] = useState<"square" | "stripe">(
    initialProvider ?? "square",
  );
  const [noshowEnabled, setNoshowEnabled] = useState(initialNoshowEnabled);
  const [noshowPct, setNoshowPct] = useState(String(initialNoshowPct));
  const [noshowThreshold, setNoshowThreshold] = useState(String(initialNoshowThreshold));
  const [cardSaveMsg, setCardSaveMsg] = useState<string | null>(null);

  function saveCardSettings() {
    startTransition(async () => {
      const r = await updateNoShowCardSettings(slug, {
        payment_provider: provider,
        noshow_protection_enabled: noshowEnabled,
        noshow_fee_percent: parseInt(noshowPct, 10) || 0,
        noshow_risk_threshold: parseInt(noshowThreshold, 10) || 0,
      });
      setCardSaveMsg(r.ok ? "Đã lưu" : (r.error ?? "Lỗi"));
      setTimeout(() => setCardSaveMsg(null), 3000);
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
        deposit_high_value_cents: isNaN(cents) ? 10000 : cents,
        deposit_pct_no_show: parseInt(pctNoShow, 10),
        deposit_pct_high_value: parseInt(pctHighValue, 10),
        deposit_pct_new_customer: parseInt(pctNewCustomer, 10),
        deposit_enabled: depositEnabled,
        deposit_hold_grace_minutes: parseInt(grace, 10) || 30,
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

        {/* Summary cards */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="Unconfirmed (48h)" value={summary.unconfirmedCount} />
          <StatCard label="High risk" value={summary.highRiskCount} color="text-red-400" />
          <StatCard label="Deposit required" value={summary.depositRequiredCount} color="text-amber-400" />
          <StatCard label="Cancelled today" value={summary.cancelledTodayCount} />
          <StatCard label="Waitlist waiting" value={summary.waitingWaitlistCount} color="text-nq-gold" />
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
                      ? "border-nq-gold bg-nq-gold/15 text-nq-gold"
                      : "border-nq-border/50 text-nq-muted hover:border-nq-gold/40"
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
                className="h-4 w-4 accent-nq-gold"
              />
              Bật yêu cầu lưu thẻ no-show
            </label>

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

            <button
              onClick={saveCardSettings}
              disabled={isPending}
              className="mt-4 rounded-xl bg-nq-gold px-4 py-2 text-xs font-semibold text-black transition hover:bg-nq-gold/90 disabled:opacity-50"
            >
              {isPending ? "Đang lưu…" : "Lưu"}
            </button>
            {cardSaveMsg && (
              <p className="mt-2 text-xs text-emerald-400">{cardSaveMsg}</p>
            )}
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
                className={`relative h-6 w-11 rounded-full transition ${remindersEnabled ? "bg-nq-gold" : "bg-nq-border"}`}
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
                    className="h-4 w-4 rounded accent-nq-gold"
                  />
                  <span className="text-sm text-nq-text">24-hour reminder</span>
                </label>
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={reminder3h}
                    onChange={(e) => setReminder3h(e.target.checked)}
                    className="h-4 w-4 rounded accent-nq-gold"
                  />
                  <span className="text-sm text-nq-text">3-hour reminder</span>
                </label>
                <p className="mt-1 text-xs font-medium uppercase tracking-widest text-nq-muted">SMS</p>
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={smsReminders}
                    onChange={(e) => setSmsReminders(e.target.checked)}
                    className="h-4 w-4 rounded accent-nq-gold"
                  />
                  <span className="text-sm text-nq-text">
                    SMS reminders
                    <span className="ml-2 text-xs text-nq-muted">(requires Twilio phone number)</span>
                  </span>
                </label>
                <div className="flex items-center gap-3">
                  <label className="text-sm text-nq-text whitespace-nowrap">High-value threshold ($)</label>
                  <input
                    type="number"
                    min="0"
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    className="w-24 rounded-lg border border-nq-border/40 bg-nq-bg px-3 py-1.5 text-sm text-nq-text focus:outline-none focus:border-nq-gold/50"
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
                    className="h-4 w-4 accent-nq-gold"
                  />
                  <span>Bật thu cọc (Square) / Enable deposits</span>
                </label>
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
                    className="ml-auto w-20 rounded-lg border border-nq-border/40 bg-nq-bg px-2 py-1.5 text-sm text-nq-text focus:outline-none focus:border-nq-gold/50"
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
                          className="w-16 rounded-lg border border-nq-border/40 bg-nq-bg px-2 py-1.5 text-sm text-nq-text focus:outline-none focus:border-nq-gold/50"
                        />
                        <span className="text-xs text-nq-muted">%</span>
                      </span>
                    </label>
                  ))}
                </div>
                <button
                  onClick={saveSettings}
                  disabled={isPending}
                  className="mt-2 rounded-xl bg-nq-gold px-4 py-2 text-xs font-semibold text-black transition hover:bg-nq-gold/90 disabled:opacity-50"
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
            <h2 className="mb-3 text-xs font-medium uppercase tracking-widest text-nq-gold">
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
            <h2 className="mb-3 text-xs font-medium uppercase tracking-widest text-nq-gold">
              Waitlist Opportunities
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
                      ? "border-nq-gold/30 bg-nq-gold/10 text-nq-gold"
                      : "border-nq-border/30 text-nq-muted"
                  }`}>
                    {w.status}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {unconfirmed.length === 0 && waitlist.length === 0 && (
          <div className="mt-12 text-center text-sm text-nq-muted">
            <p>All clear — no unconfirmed bookings in the next 48 hours.</p>
          </div>
        )}
      </MobileStack>
    </ResponsiveShell>
  );
}
