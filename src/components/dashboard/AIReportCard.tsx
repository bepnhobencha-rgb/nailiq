"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import {
  getAIReportSettings,
  saveAIReportSettings,
  sendTestDailyReport,
} from "@/shared/ai/aiReportActions";

type Channel = "email" | "sms" | "both";

const CHANNEL_LABELS: Record<Channel, { en: string; vi: string }> = {
  email: { en: "Email only", vi: "Chỉ email" },
  sms: { en: "SMS only", vi: "Chỉ SMS" },
  both: { en: "Email + SMS", vi: "Email + SMS" },
};

/**
 * Settings card for AI Manager daily briefing channel:
 *   - owner_notification_channel (email / sms / both)
 *   - owner_phone (E.164, required for SMS channels)
 *   - "Send test report" button
 */
export function AIReportCard({ slug }: { slug: string }) {
  const [channel, setChannel] = useState<Channel>("email");
  const [phone, setPhone] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, startSave] = useTransition();
  const [testing, startTest] = useTransition();
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void getAIReportSettings(slug).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setChannel(r.channel);
        setPhone(r.ownerPhone);
      }
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [slug]);

  function onSave() {
    setToast(null);
    startSave(async () => {
      const r = await saveAIReportSettings(slug, { channel, ownerPhone: phone });
      if (r.ok) {
        setToast({ kind: "ok", msg: "Đã lưu" });
      } else {
        const msg =
          r.error === "invalid_phone"
            ? "Số điện thoại không hợp lệ (cần dạng +16045550100)"
            : "Lưu thất bại — thử lại";
        setToast({ kind: "err", msg });
      }
    });
  }

  function onTest() {
    setToast(null);
    startTest(async () => {
      const r = await sendTestDailyReport(slug);
      if (r.ok) {
        setToast({ kind: "ok", msg: "Báo cáo thử đã gửi ✓" });
      } else {
        setToast({ kind: "err", msg: "Gửi thất bại — kiểm tra kênh thông báo" });
      }
    });
  }

  const needsPhone = channel === "sms" || channel === "both";

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div>
        <h3 className="font-semibold text-base">📊 Báo cáo AI hàng ngày</h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          AI Manager gửi tóm tắt cuối ngày lúc 21:00 giờ tiệm — doanh thu, lịch hẹn, no-show.
        </p>
      </div>

      {!loaded ? (
        <div className="h-20 animate-pulse rounded-lg bg-muted" />
      ) : (
        <div className="space-y-4">
          {/* Channel selector */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Kênh nhận báo cáo</label>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(CHANNEL_LABELS) as Channel[]).map((c) => (
                <button
                  key={c}
                  onClick={() => setChannel(c)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    channel === c
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:bg-muted"
                  }`}
                >
                  {CHANNEL_LABELS[c].vi}
                </button>
              ))}
            </div>
          </div>

          {/* Owner phone (shown when SMS is selected) */}
          {needsPhone && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Số điện thoại chủ tiệm{" "}
                <span className="text-muted-foreground font-normal">(E.164, ví dụ +16045550100)</span>
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+16045550100"
                className="input w-full max-w-xs"
              />
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onSave} disabled={saving} size="sm">
              {saving ? "Đang lưu…" : "Lưu"}
            </Button>
            <Button
              onClick={onTest}
              disabled={testing}
              variant="secondary"
              size="sm"
            >
              {testing ? "Đang gửi…" : "Gửi báo cáo thử"}
            </Button>
          </div>

          {toast && (
            <p
              className={`text-sm ${
                toast.kind === "ok" ? "text-green-600" : "text-destructive"
              }`}
            >
              {toast.msg}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
