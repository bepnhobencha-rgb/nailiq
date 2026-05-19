"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  updateRemindersEnabled,
  updateReminderSettings,
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

type Props = {
  slug: string;
  isOwner: boolean;
  remindersEnabled: boolean;
  reminder24hEnabled: boolean;
  reminder3hEnabled: boolean;
  smsRemindersEnabled: boolean;
  depositHighValueCents: number;
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
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [waivedIds, setWaivedIds] = useState<Set<string>>(new Set());

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
