"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, Send, Users, CheckCircle2, CalendarCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { cn } from "@/shared/lib/cn";
import {
  sendReoptinTestAction,
  sendReoptinCampaignAction,
} from "@/app/dashboard/[slug]/marketing/actions";

type Stats = {
  eligible: number;
  sent: number;
  confirmed: number;
  booked: number;
};

export function MarketingCampaigns({
  slug,
  salonName,
  stats,
}: {
  slug: string;
  salonName: string;
  stats: Stats;
}) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const router = useRouter();

  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const [testing, setTesting] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [limit, setLimit] = useState(20);

  const t = (en: string, viStr: string) => (vi ? viStr : en);

  async function handleTest() {
    setTesting(true);
    const res = await sendReoptinTestAction(slug);
    setTesting(false);
    if (res.ok) {
      setToast({
        variant: "success",
        message: t(
          `Test email sent to ${res.sentTo}`,
          `Đã gửi email thử tới ${res.sentTo}`,
        ),
      });
    } else {
      setToast({
        variant: "error",
        message: t("Couldn't send the test email.", "Không gửi được email thử."),
      });
    }
  }

  async function handleSend() {
    setSending(true);
    const res = await sendReoptinCampaignAction(slug, limit);
    setSending(false);
    setConfirmOpen(false);
    if (res.ok) {
      const n = res.summary.sent;
      setToast({
        variant: "success",
        message: t(
          `Sent ${n} email${n === 1 ? "" : "s"}.`,
          `Đã gửi ${n} email.`,
        ),
      });
      router.refresh();
    } else {
      setToast({
        variant: "error",
        message: t("Couldn't send the campaign.", "Không gửi được chiến dịch."),
      });
    }
  }

  const cappedLimit = Math.max(1, Math.min(limit || 1, stats.eligible || 1));

  const tiles: { label: string; value: number; icon: typeof Users; tone: string }[] = [
    { label: t("Eligible", "Đủ điều kiện"), value: stats.eligible, icon: Users, tone: "text-nq-foreground" },
    { label: t("Sent", "Đã gửi"), value: stats.sent, icon: Mail, tone: "text-nq-foreground" },
    { label: t("Opted in", "Đã xác nhận"), value: stats.confirmed, icon: CheckCircle2, tone: "text-nq-success" },
    { label: t("Booked", "Đã đặt hẹn"), value: stats.booked, icon: CalendarCheck, tone: "text-nq-primary" },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-nq-foreground">
          {t("Marketing", "Marketing")}
        </h1>
        <p className="mt-1 text-sm text-nq-muted">
          {t(
            "Reach your customers with one-tap campaigns.",
            "Chạy chiến dịch tới khách hàng chỉ bằng một chạm.",
          )}
        </p>
      </header>

      {/* Re-opt-in campaign */}
      <section className="rounded-2xl border border-nq-border bg-nq-surface p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
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
          </div>
        </div>

        {/* Stats */}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {tiles.map((tile) => {
            const Icon = tile.icon;
            return (
              <div
                key={tile.label}
                className="rounded-xl border border-nq-border/60 bg-nq-bg/30 px-3 py-3"
              >
                <div className="flex items-center gap-1.5 text-nq-muted">
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  <span className="text-[11px] font-medium uppercase tracking-wide">
                    {tile.label}
                  </span>
                </div>
                <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tile.tone)}>
                  {tile.value.toLocaleString()}
                </p>
              </div>
            );
          })}
        </div>

        {/* Actions */}
        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <Button
            variant="primary"
            leftIcon={<Send className="h-4 w-4" />}
            disabled={stats.eligible === 0}
            onClick={() => {
              setLimit(Math.min(20, stats.eligible || 20));
              setConfirmOpen(true);
            }}
          >
            {t("Send campaign", "Gửi chiến dịch")}
          </Button>
          <Button
            variant="secondary"
            leftIcon={<Mail className="h-4 w-4" />}
            loading={testing}
            onClick={handleTest}
          >
            {t("Send test to me", "Gửi thử cho tôi")}
          </Button>
        </div>
        {stats.eligible === 0 ? (
          <p className="mt-2.5 text-xs text-nq-muted">
            {t(
              "Everyone eligible has already been sent this campaign.",
              "Tất cả khách đủ điều kiện đều đã được gửi chiến dịch này.",
            )}
          </p>
        ) : null}
      </section>

      {/* Confirm send modal */}
      <Modal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        size="sm"
        title={t("Send re-opt-in campaign", "Gửi chiến dịch xin lại xác nhận")}
        description={t(
          "Real emails go out immediately to your customers. This can't be undone.",
          "Email thật sẽ gửi ngay tới khách hàng. Không thể hoàn tác.",
        )}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={sending}>
              {t("Cancel", "Huỷ")}
            </Button>
            <Button variant="primary" loading={sending} onClick={handleSend}>
              {t(`Send ${cappedLimit} email${cappedLimit === 1 ? "" : "s"}`, `Gửi ${cappedLimit} email`)}
            </Button>
          </div>
        }
      >
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
          <span className="mt-1.5 block text-xs text-nq-muted">
            {t(
              `${stats.eligible.toLocaleString()} eligible in total. Already-sent customers are skipped automatically.`,
              `Tổng ${stats.eligible.toLocaleString()} khách đủ điều kiện. Người đã gửi sẽ tự động bỏ qua.`,
            )}
          </span>
        </label>
      </Modal>

      <SetupToast toast={toast} onDismiss={() => setToast(null)} autoDismissMs={4000} />
    </div>
  );
}
