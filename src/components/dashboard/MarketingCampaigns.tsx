"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Mail,
  Send,
  Users,
  CheckCircle2,
  CalendarCheck,
  Clock,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { cn } from "@/shared/lib/cn";
import {
  sendReoptinTestAction,
  sendReoptinCampaignAction,
  scheduleReoptinCampaignAction,
  cancelScheduleAction,
} from "@/app/dashboard/[slug]/marketing/actions";

type Stats = { eligible: number; sent: number; confirmed: number; booked: number };
type Schedule = {
  id: string;
  campaign_type: string;
  send_limit: number;
  scheduled_at: string;
  status: string;
};

// Salon-calendar-date helpers — pure date math so DST/offset never bite.
function salonToday(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function weekdayOf(ymd: string): number {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
}

export function MarketingCampaigns({
  slug,
  salonName,
  timezone,
  stats,
  schedules,
}: {
  slug: string;
  salonName: string;
  timezone: string;
  stats: Stats;
  schedules: Schedule[];
}) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const router = useRouter();
  const t = (en: string, viStr: string) => (vi ? viStr : en);

  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const [testing, setTesting] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [limit, setLimit] = useState(20);
  const [mode, setMode] = useState<"now" | "schedule">("now");

  const today = salonToday(timezone);
  const [date, setDate] = useState(addDaysYmd(today, 1));
  const [hour, setHour] = useState(10);

  const pending = schedules.filter((s) => s.status === "pending");

  function fmtSchedule(iso: string): string {
    return new Intl.DateTimeFormat(vi ? "vi-VN" : "en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  }

  async function handleTest() {
    setTesting(true);
    const res = await sendReoptinTestAction(slug);
    setTesting(false);
    setToast(
      res.ok
        ? { variant: "success", message: t(`Test email sent to ${res.sentTo}`, `Đã gửi email thử tới ${res.sentTo}`) }
        : { variant: "error", message: t("Couldn't send the test email.", "Không gửi được email thử.") },
    );
  }

  async function handleSend() {
    setSending(true);
    const res = await sendReoptinCampaignAction(slug, limit);
    setSending(false);
    setConfirmOpen(false);
    if (res.ok) {
      const n = res.summary.sent;
      setToast({ variant: "success", message: t(`Sent ${n} email${n === 1 ? "" : "s"}.`, `Đã gửi ${n} email.`) });
      router.refresh();
    } else {
      setToast({ variant: "error", message: t("Couldn't send the campaign.", "Không gửi được chiến dịch.") });
    }
  }

  async function handleSchedule() {
    setSending(true);
    const res = await scheduleReoptinCampaignAction(slug, limit, date, hour);
    setSending(false);
    setConfirmOpen(false);
    if (res.ok) {
      setToast({ variant: "success", message: t(`Scheduled for ${fmtSchedule(res.scheduledAtIso)}`, `Đã hẹn lịch: ${fmtSchedule(res.scheduledAtIso)}`) });
      router.refresh();
    } else {
      const msg = res.error === "past"
        ? t("Pick a time in the future.", "Chọn thời điểm trong tương lai.")
        : t("Couldn't schedule the campaign.", "Không hẹn được lịch.");
      setToast({ variant: "error", message: msg });
    }
  }

  async function handleCancel(id: string) {
    const res = await cancelScheduleAction(slug, id);
    if (res.ok) {
      setToast({ variant: "success", message: t("Schedule canceled.", "Đã huỷ lịch.") });
      router.refresh();
    }
  }

  const cappedLimit = Math.max(1, Math.min(limit || 1, stats.eligible || 1));

  const tiles = [
    { label: t("Eligible", "Đủ điều kiện"), value: stats.eligible, icon: Users, tone: "text-nq-foreground" },
    { label: t("Sent", "Đã gửi"), value: stats.sent, icon: Mail, tone: "text-nq-foreground" },
    { label: t("Opted in", "Đã xác nhận"), value: stats.confirmed, icon: CheckCircle2, tone: "text-nq-success" },
    { label: t("Booked", "Đã đặt hẹn"), value: stats.booked, icon: CalendarCheck, tone: "text-nq-primary" },
  ];

  // Quick-pick presets → [label, dateYmd, hour]
  const nextSaturday = addDaysYmd(today, ((6 - weekdayOf(today) + 7) % 7) || 7);
  const quickPicks: { label: string; date: string; hour: number }[] = [
    { label: t("Tomorrow 10am", "Sáng mai 10h"), date: addDaysYmd(today, 1), hour: 10 },
    { label: t("Saturday 10am", "Thứ Bảy 10h"), date: nextSaturday, hour: 10 },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-nq-foreground">Marketing</h1>
        <p className="mt-1 text-sm text-nq-muted">
          {t("Reach your customers with one-tap campaigns.", "Chạy chiến dịch tới khách hàng chỉ bằng một chạm.")}
        </p>
      </header>

      <section className="rounded-2xl border border-nq-border bg-nq-surface p-5">
        <div className="flex items-center gap-2">
          <span className="text-lg" aria-hidden>💌</span>
          <h2 className="text-base font-semibold text-nq-foreground">
            {t("Re-opt-in campaign", "Chiến dịch xin lại xác nhận")}
          </h2>
        </div>
        <p className="mt-1.5 max-w-prose text-sm text-nq-muted">
          {t(
            `Invite customers who haven't opted in yet to keep getting reminders and offers from ${salonName} — they confirm by booking, with 10% off their next visit.`,
            `Mời những khách chưa đồng ý nhận tin tiếp tục nhận nhắc hẹn & ưu đãi từ ${salonName} — họ xác nhận bằng cách đặt hẹn, kèm giảm 10% lần tới.`,
          )}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {tiles.map((tile) => {
            const Icon = tile.icon;
            return (
              <div key={tile.label} className="rounded-xl border border-nq-border/60 bg-nq-bg/30 px-3 py-3">
                <div className="flex items-center gap-1.5 text-nq-muted">
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  <span className="text-[11px] font-medium uppercase tracking-wide">{tile.label}</span>
                </div>
                <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tile.tone)}>{tile.value.toLocaleString()}</p>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <Button
            variant="primary"
            leftIcon={<Send className="h-4 w-4" />}
            disabled={stats.eligible === 0}
            onClick={() => {
              setLimit(Math.min(20, stats.eligible || 20));
              setMode("now");
              setConfirmOpen(true);
            }}
          >
            {t("Send campaign", "Gửi chiến dịch")}
          </Button>
          <Button variant="secondary" leftIcon={<Mail className="h-4 w-4" />} loading={testing} onClick={handleTest}>
            {t("Send test to me", "Gửi thử cho tôi")}
          </Button>
        </div>
        {stats.eligible === 0 ? (
          <p className="mt-2.5 text-xs text-nq-muted">
            {t("Everyone eligible has already been sent this campaign.", "Tất cả khách đủ điều kiện đều đã được gửi chiến dịch này.")}
          </p>
        ) : null}

        {/* Pending schedules */}
        {pending.length > 0 ? (
          <div className="mt-5 border-t border-nq-border/60 pt-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-nq-muted">
              <Clock className="h-3.5 w-3.5" aria-hidden />
              {t("Scheduled", "Đang chờ gửi")}
            </p>
            <ul className="flex flex-col gap-2">
              {pending.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-nq-border/60 bg-nq-bg/30 px-3 py-2.5"
                >
                  <span className="min-w-0 text-sm text-nq-foreground">
                    {fmtSchedule(s.scheduled_at)}
                    <span className="text-nq-muted"> · {t(`${s.send_limit} customers`, `${s.send_limit} khách`)}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCancel(s.id)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-full border border-nq-border/60 px-2.5 py-1 text-xs text-nq-muted transition-colors hover:border-nq-error/50 hover:text-nq-error"
                  >
                    <X className="h-3 w-3" aria-hidden />
                    {t("Cancel", "Huỷ")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {/* Send / schedule modal */}
      <Modal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        size="sm"
        title={t("Send re-opt-in campaign", "Gửi chiến dịch xin lại xác nhận")}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={sending}>
              {t("Cancel", "Huỷ")}
            </Button>
            {mode === "now" ? (
              <Button variant="primary" loading={sending} onClick={handleSend}>
                {t(`Send ${cappedLimit} now`, `Gửi ${cappedLimit} ngay`)}
              </Button>
            ) : (
              <Button variant="primary" loading={sending} leftIcon={<Clock className="h-4 w-4" />} onClick={handleSchedule}>
                {t("Schedule", "Hẹn lịch")}
              </Button>
            )}
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <label className="block text-sm">
            <span className="text-nq-muted">
              {t("How many customers (highest spenders first)", "Gửi cho bao nhiêu khách (chi tiêu cao trước)")}
            </span>
            <input
              type="number"
              min={1}
              max={Math.max(1, stats.eligible)}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              className="mt-1.5 w-full rounded-lg border border-nq-border/60 bg-nq-bg/40 px-3 py-2 text-nq-foreground focus:outline-none focus:ring-1 focus:ring-nq-primary/50"
            />
            <span className="mt-1 block text-xs text-nq-muted">
              {t(
                `${stats.eligible.toLocaleString()} eligible. Already-sent customers are skipped.`,
                `${stats.eligible.toLocaleString()} khách đủ điều kiện. Người đã gửi sẽ tự bỏ qua.`,
              )}
            </span>
          </label>

          {/* Now vs schedule */}
          <div className="grid grid-cols-2 gap-2">
            {(["now", "schedule"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                  mode === m
                    ? "border-nq-primary bg-nq-primary/10 text-nq-primary"
                    : "border-nq-border/60 text-nq-muted hover:text-nq-foreground",
                )}
              >
                {m === "now" ? t("Send now", "Gửi ngay") : t("Schedule", "Hẹn giờ")}
              </button>
            ))}
          </div>

          {mode === "schedule" ? (
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap gap-2">
                {quickPicks.map((q) => {
                  const active = date === q.date && hour === q.hour;
                  return (
                    <button
                      key={q.label}
                      type="button"
                      onClick={() => {
                        setDate(q.date);
                        setHour(q.hour);
                      }}
                      className={cn(
                        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                        active
                          ? "border-nq-primary bg-nq-primary/10 text-nq-primary"
                          : "border-nq-border/60 text-nq-muted hover:text-nq-foreground",
                      )}
                    >
                      {q.label}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <input
                  type="date"
                  min={today}
                  max={addDaysYmd(today, 30)}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="flex-1 rounded-lg border border-nq-border/60 bg-nq-bg/40 px-3 py-2 text-sm text-nq-foreground focus:outline-none focus:ring-1 focus:ring-nq-primary/50"
                />
                <select
                  value={hour}
                  onChange={(e) => setHour(Number(e.target.value))}
                  className="rounded-lg border border-nq-border/60 bg-nq-bg/40 px-3 py-2 text-sm text-nq-foreground focus:outline-none focus:ring-1 focus:ring-nq-primary/50"
                >
                  {Array.from({ length: 13 }, (_, i) => i + 8).map((h) => (
                    <option key={h} value={h}>
                      {h}:00
                    </option>
                  ))}
                </select>
              </div>
              <span className="text-xs text-nq-muted">
                {t("Salon local time. You can cancel any time before it sends.", "Giờ tiệm. Có thể huỷ bất cứ lúc nào trước khi gửi.")}
              </span>
            </div>
          ) : (
            <p className="text-xs text-nq-muted">
              {t(
                "Real emails go out immediately. This can't be undone.",
                "Email thật gửi ngay lập tức. Không thể hoàn tác.",
              )}
            </p>
          )}
        </div>
      </Modal>

      <SetupToast toast={toast} onDismiss={() => setToast(null)} autoDismissMs={4000} />
    </div>
  );
}
