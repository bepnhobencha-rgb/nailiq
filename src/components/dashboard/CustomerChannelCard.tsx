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
  smsA2pRegistered: false,
  customerChannel: "smart",
};

const CHANNEL_OPTIONS: { value: CustomerChannelMode; labelEn: string; labelVi: string; descEn: string; descVi: string }[] = [
  {
    value: "smart",
    labelEn: "Smart (recommended)",
    labelVi: "Thông minh (khuyến nghị)",
    descEn: "Email when available, SMS when A2P registered; skips if neither works.",
    descVi: "Email khi có; SMS khi A2P đã đăng ký; bỏ qua nếu không có kênh nào.",
  },
  {
    value: "sms_and_email",
    labelEn: "SMS + Email (parallel)",
    labelVi: "SMS + Email (song song)",
    descEn: "Sends to both channels simultaneously — maximum reach post-A2P registration.",
    descVi: "Gửi đồng thời cả hai kênh — phủ sóng tối đa sau khi đăng ký A2P.",
  },
  {
    value: "email_only",
    labelEn: "Email only",
    labelVi: "Chỉ email",
    descEn: "Skip SMS entirely. Good while A2P registration is pending.",
    descVi: "Bỏ qua SMS hoàn toàn. Phù hợp khi chờ đăng ký A2P.",
  },
  {
    value: "sms_only",
    labelEn: "SMS only",
    labelVi: "Chỉ SMS",
    descEn: "SMS only. Requires A2P registration to be effective in the US.",
    descVi: "Chỉ SMS. Cần đăng ký A2P mới hiệu quả tại Mỹ.",
  },
];

/**
 * Admin Settings card — customer communication channel preferences.
 * Controls whether automated messages use SMS, email, or both.
 * Also tracks A2P 10DLC registration status which gates all non-OTP SMS.
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

  const a2pStatusColor = settings.smsA2pRegistered
    ? "text-nq-success"
    : "text-nq-warning";
  const a2pStatusLabel = settings.smsA2pRegistered
    ? isVi ? "✅ Đã đăng ký A2P" : "✅ A2P Registered"
    : isVi ? "⚠️ Chưa đăng ký A2P — SMS tự động có thể bị carriers Mỹ chặn" : "⚠️ A2P not registered — automated SMS may be silently filtered by US carriers";

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
          {/* A2P registration status */}
          <div className="flex flex-col gap-2 rounded-lg border border-nq-border/60 bg-nq-surface-2 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
              {isVi ? "Đăng ký Twilio A2P 10DLC" : "Twilio A2P 10DLC Registration"}
            </p>
            <p className={`text-sm font-medium ${a2pStatusColor}`}>{a2pStatusLabel}</p>
            {!settings.smsA2pRegistered && (
              <p className="text-xs text-nq-muted">
                {isVi
                  ? "US carriers (AT&T, Verizon, T-Mobile) lọc yên lặng tin nhắn có link từ số chưa đăng ký A2P. Đăng ký tại Twilio Console → Messaging → Regulatory Compliance. Sau khi được duyệt, bật toggle bên dưới."
                  : "US carriers silently filter link-bearing SMS from unregistered numbers. Register at Twilio Console → Messaging → Regulatory Compliance → A2P 10DLC. Once approved, toggle below."}
              </p>
            )}
            <label className="mt-1 flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                data-testid="a2p-registered-toggle"
                checked={settings.smsA2pRegistered}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, smsA2pRegistered: e.target.checked }))
                }
                className="size-4 accent-nq-primary"
              />
              <span className="text-sm font-medium text-nq-foreground">
                {isVi
                  ? "A2P đã được phê duyệt — bật nhắn SMS tự động"
                  : "A2P registration approved — enable automated SMS"}
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
  const { smsA2pRegistered, customerChannel: channelOf } = s;
  if (channelOf === "email_only") {
    return isVi
      ? "Chỉ dùng email. SMS hoàn toàn tắt."
      : "Email only. SMS is completely disabled.";
  }
  if (channelOf === "sms_only") {
    return smsA2pRegistered
      ? isVi ? "Chỉ SMS. Email không gửi." : "SMS only. Email is skipped."
      : isVi
        ? "Chỉ SMS nhưng A2P chưa đăng ký → tin nhắn có thể bị chặn."
        : "SMS only but A2P not registered → messages may be silently dropped.";
  }
  if (channelOf === "sms_and_email") {
    return smsA2pRegistered
      ? isVi ? "SMS + Email song song khi có email khách." : "SMS + Email in parallel when customer email is on file."
      : isVi
        ? "Email khi có; SMS tắt do A2P chưa đăng ký."
        : "Email when available; SMS off (A2P not registered).";
  }
  // smart
  return smsA2pRegistered
    ? isVi
      ? "Email + SMS song song khi có email; SMS-only khi không có email."
      : "Email + SMS when customer has email; SMS-only otherwise."
    : isVi
      ? "Email khi có; SMS tắt (chờ A2P). Khách không có email sẽ bị bỏ qua."
      : "Email when available; SMS off (pending A2P). Customers with no email are skipped.";
}
