"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import {
  getCustomerChannelSettings,
  saveCustomerChannelSettings,
  type CustomerChannelSettings,
} from "@/shared/dashboard/customerChannelActions";
import type { CustomerChannelMode } from "@/shared/lib/channelResolver";

const DEFAULT: CustomerChannelSettings = {
  smsOutboundEnabled: true,
  emailOutboundEnabled: true,
  customerChannel: "smart",
};

const CHANNEL_OPTIONS: { value: CustomerChannelMode; labelEn: string; labelVi: string; descEn: string; descVi: string }[] = [
  {
    value: "smart",
    labelEn: "Smart (recommended)",
    labelVi: "Thông minh (khuyến nghị)",
    descEn: "Email when available, SMS when outbound is on; skips if neither works.",
    descVi: "Email khi có; SMS khi bật; bỏ qua nếu không có kênh nào.",
  },
  {
    value: "sms_and_email",
    labelEn: "SMS + Email (parallel)",
    labelVi: "SMS + Email (song song)",
    descEn: "Sends to both channels simultaneously — maximum reach.",
    descVi: "Gửi đồng thời cả hai kênh — phủ sóng tối đa.",
  },
  {
    value: "email_only",
    labelEn: "Email only",
    labelVi: "Chỉ email",
    descEn: "Skip SMS entirely. Good while waiting for US A2P registration.",
    descVi: "Bỏ qua SMS hoàn toàn. Phù hợp khi chờ đăng ký A2P (Mỹ).",
  },
  {
    value: "sms_only",
    labelEn: "SMS only",
    labelVi: "Chỉ SMS",
    descEn: "SMS only. In the US, requires A2P 10DLC registration to avoid carrier filtering.",
    descVi: "Chỉ SMS. Tại Mỹ cần đăng ký A2P 10DLC để không bị chặn.",
  },
];

/**
 * Admin Settings card — customer communication channel preferences.
 * Controls whether automated messages use SMS, email, or both.
 * `smsOutboundEnabled` is the operational gate (default ON — non-US salons
 * work without any setup; US salons pending A2P should turn it OFF).
 */
export function CustomerChannelCard({ slug }: { slug: string }) {
  const { language } = useUserLanguage();
  const isVi = language === "vi";

  const [settings, setSettings] = useState<CustomerChannelSettings>(DEFAULT);
  const [loaded, setLoaded] = useState(false);
  const [saving, startSave] = useTransition();
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void getCustomerChannelSettings(slug).then((r) => {
      if (!alive) return;
      if (r.ok) setSettings(r.settings);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [slug]);

  function onSave() {
    setToast(null);
    startSave(async () => {
      const r = await saveCustomerChannelSettings(slug, settings);
      if (r.ok) {
        setSettings(r.settings);
        setToast({ kind: "ok", msg: isVi ? "Đã lưu." : "Saved." });
      } else {
        setToast({ kind: "err", msg: isVi ? "Lưu thất bại." : "Save failed." });
      }
    });
  }

  const smsStatusColor = settings.smsOutboundEnabled ? "text-nq-success" : "text-nq-warning";
  const smsStatusLabel = settings.smsOutboundEnabled
    ? isVi ? "✅ SMS đang bật" : "✅ SMS outbound enabled"
    : isVi ? "⚠️ SMS đang tắt — khách không có email sẽ bị bỏ qua" : "⚠️ SMS disabled — customers with no email will be skipped";

  const emailStatusColor = settings.emailOutboundEnabled ? "text-nq-success" : "text-nq-warning";
  const emailStatusLabel = settings.emailOutboundEnabled
    ? isVi ? "✅ Email đang bật" : "✅ Email outbound enabled"
    : isVi ? "⚠️ Email đang tắt — khách chỉ nhận SMS" : "⚠️ Email disabled — customers receive SMS only";

  return (
    <section
      data-testid="customer-channel-card"
      className="rounded-xl border border-nq-border bg-nq-surface p-5"
    >
      <h2 className="text-base font-semibold text-nq-foreground">
        {isVi ? "Kênh nhắn tin cho khách" : "Customer Communication Channel"}
      </h2>
      <p className="mt-1 text-sm text-nq-muted">
        {isVi
          ? "Kiểm soát cách AI & hệ thống nhắn tin tự động liên lạc với khách hàng."
          : "Controls how automated messages and AI agents reach your customers."}
      </p>

      {!loaded ? (
        <p className="mt-4 text-sm italic text-nq-muted">
          {isVi ? "Đang tải…" : "Loading…"}
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          {/* SMS outbound toggle */}
          <div className="flex flex-col gap-2 rounded-lg border border-nq-border/60 bg-nq-surface-2 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
              {isVi ? "Nhắn tin SMS tự động" : "Automated SMS"}
            </p>
            <p className={`text-sm font-medium ${smsStatusColor}`}>{smsStatusLabel}</p>
            {!settings.smsOutboundEnabled && (
              <p className="text-xs text-nq-muted">
                {isVi
                  ? "Khi tắt, AI agents và nhắc hẹn chỉ dùng email. Khách không có email sẽ bị bỏ qua tạm thời."
                  : "When off, AI agents and reminders use email only. Customers with no email are temporarily skipped."}
              </p>
            )}
            <label className="mt-1 flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                data-testid="sms-outbound-toggle"
                checked={settings.smsOutboundEnabled}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, smsOutboundEnabled: e.target.checked }))
                }
                className="size-4 accent-nq-primary"
              />
              <span className="text-sm font-medium text-nq-foreground">
                {isVi ? "Bật gửi SMS tự động" : "Enable automated SMS outbound"}
              </span>
            </label>
            <p className="text-xs text-nq-muted/70">
              {isVi
                ? "Salon tại Mỹ cần đăng ký Twilio A2P 10DLC trước khi bật (Twilio Console → Messaging → Regulatory Compliance). Salon Canada và quốc gia khác: bật ngay."
                : "US salons must complete Twilio A2P 10DLC registration first (Twilio Console → Messaging → Regulatory Compliance). Canada and other countries: enable immediately."}
            </p>
          </div>

          {/* Email outbound toggle */}
          <div className="flex flex-col gap-2 rounded-lg border border-nq-border/60 bg-nq-surface-2 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
              {isVi ? "Nhắn tin Email tự động" : "Automated Email"}
            </p>
            <p className={`text-sm font-medium ${emailStatusColor}`}>{emailStatusLabel}</p>
            {!settings.emailOutboundEnabled && (
              <p className="text-xs text-nq-muted">
                {isVi
                  ? "Khi tắt, tất cả email tự động bị chặn: xác nhận, nhắc hẹn, AI win-back, VIP care. Chỉ SMS được gửi."
                  : "When off, all automated emails are suppressed: confirmations, reminders, AI win-back, VIP care. SMS only."}
              </p>
            )}
            <label className="mt-1 flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                data-testid="email-outbound-toggle"
                checked={settings.emailOutboundEnabled}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, emailOutboundEnabled: e.target.checked }))
                }
                className="size-4 accent-nq-primary"
              />
              <span className="text-sm font-medium text-nq-foreground">
                {isVi ? "Bật gửi email tự động" : "Enable automated email outbound"}
              </span>
            </label>
          </div>

          {/* Channel mode */}
          <div className="flex flex-col gap-2 border-t border-nq-border/40 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
              {isVi ? "Chế độ kênh" : "Channel Mode"}
            </p>
            {CHANNEL_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="customer-channel-mode"
                  data-testid={`channel-mode-${opt.value}`}
                  checked={settings.customerChannel === opt.value}
                  onChange={() =>
                    setSettings((s) => ({ ...s, customerChannel: opt.value }))
                  }
                  className="mt-0.5 size-4 accent-nq-primary"
                />
                <div>
                  <span className="text-sm font-medium text-nq-foreground">
                    {isVi ? opt.labelVi : opt.labelEn}
                  </span>
                  <p className="mt-0.5 text-xs text-nq-muted">
                    {isVi ? opt.descVi : opt.descEn}
                  </p>
                </div>
              </label>
            ))}
          </div>

          {/* Summary badge */}
          <div className="rounded-lg bg-nq-primary/10 px-4 py-3">
            <p className="text-xs font-medium text-nq-primary">
              {isVi ? "📡 Hiện tại:" : "📡 Current behaviour:"}
            </p>
            <p className="mt-1 text-xs text-nq-muted">
              {getEffectiveSummary(settings, isVi)}
            </p>
          </div>

          {toast ? (
            <p
              data-testid="channel-card-toast"
              className={toast.kind === "ok" ? "text-sm text-nq-success" : "text-sm text-nq-error"}
              role="status"
            >
              {toast.msg}
            </p>
          ) : null}

          <div>
            <Button onClick={onSave} loading={saving} disabled={saving}>
              {isVi ? "Lưu" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function getEffectiveSummary(s: CustomerChannelSettings, isVi: boolean): string {
  const { smsOutboundEnabled, emailOutboundEnabled, customerChannel: channelOf } = s;
  if (!smsOutboundEnabled && !emailOutboundEnabled) {
    return isVi
      ? "⛔ Cả SMS lẫn email đều tắt — khách không nhận được gì."
      : "⛔ Both SMS and email are off — customers receive nothing.";
  }
  if (channelOf === "email_only") {
    return emailOutboundEnabled
      ? isVi ? "Chỉ dùng email. SMS hoàn toàn tắt." : "Email only. SMS is completely disabled."
      : isVi ? "Email only nhưng email cũng đang tắt — khách không nhận được gì." : "Email only but email is also off — customers receive nothing.";
  }
  if (channelOf === "sms_only") {
    return smsOutboundEnabled
      ? isVi ? "Chỉ SMS. Email không gửi." : "SMS only. Email is skipped."
      : isVi ? "Chỉ SMS nhưng SMS đang tắt → tin nhắn bị bỏ qua." : "SMS only but SMS is off → messages skipped.";
  }
  if (channelOf === "sms_and_email") {
    const parts = [
      smsOutboundEnabled ? (isVi ? "SMS" : "SMS") : null,
      emailOutboundEnabled ? (isVi ? "Email" : "Email") : null,
    ].filter(Boolean);
    return parts.length
      ? isVi ? `${parts.join(" + ")} song song khi có.` : `${parts.join(" + ")} in parallel when available.`
      : isVi ? "Cả hai kênh đều tắt — khách không nhận được gì." : "Both channels off — customers receive nothing.";
  }
  // smart
  if (!smsOutboundEnabled) {
    return emailOutboundEnabled
      ? isVi ? "Email khi có; SMS tắt. Khách không có email sẽ bị bỏ qua." : "Email when available; SMS off. Customers with no email are skipped."
      : isVi ? "Cả SMS lẫn email đều tắt." : "Both SMS and email are off.";
  }
  return emailOutboundEnabled
    ? isVi ? "Email + SMS song song khi có email; SMS-only khi không có email." : "Email + SMS when customer has email; SMS-only otherwise."
    : isVi ? "Chỉ SMS (email tắt)." : "SMS only (email disabled).";
}
