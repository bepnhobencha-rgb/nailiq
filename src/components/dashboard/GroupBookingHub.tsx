"use client";

import { useEffect, useState, useTransition } from "react";
import { SETTINGS_SAVE_UNCONFIRMED } from "@/shared/dashboard/settingsSaveFeedback";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import {
  loadGroupBookingSettings,
  saveGroupBookingSettings,
} from "@/shared/booking/groupBookingSettingsActions";

const PRESETS = [1, 2, 4, 12, 24];

export function GroupBookingHub({ slug }: { slug: string }) {
  const [cutoff, setCutoff] = useState(2);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await loadGroupBookingSettings(slug);
        if (!active) return;
        if (res.ok && res.settings) {
          setCutoff(res.settings.declineCutoffHours);
        } else {
          setLoadFailed(true);
        }
      } catch {
        if (active) setLoadFailed(true);
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [slug, loadAttempt]);

  function handleSave() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        const res = await saveGroupBookingSettings(slug, { declineCutoffHours: cutoff });
        if (res.ok) {
          setSaved(true);
          setTimeout(() => setSaved(false), 2500);
        } else {
          setError("Lưu thất bại. Vui lòng thử lại.");
        }
      } catch {
        setError(SETTINGS_SAVE_UNCONFIRMED.vi);
      }
    });
  }

  if (loading) {
    return (
      <Card variant="default" padding="md">
        <p className="text-sm text-nq-muted">Đang tải…</p>
      </Card>
    );
  }

  if (loadFailed) {
    return (
      <Card variant="default" padding="md">
        <p role="alert" className="text-sm text-nq-error">
          Chưa tải được cài đặt đặt nhóm. Kiểm tra kết nối rồi thử lại.
        </p>
        <Button type="button" onClick={() => {
          setLoading(true);
          setLoadFailed(false);
          setLoadAttempt((attempt) => attempt + 1);
        }}>
          Thử tải lại cài đặt đặt nhóm
        </Button>
      </Card>
    );
  }

  return (
    <Card variant="default" padding="md">
      <fieldset disabled={isPending} className="min-w-0 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-nq-foreground">Thời hạn huỷ tham dự nhóm</h3>
          <p className="mt-0.5 text-xs text-nq-muted">
            Nếu thành viên báo không đến trong vòng X giờ trước giờ hẹn, hệ thống sẽ báo{" "}
            <strong className="text-nq-foreground">Minh</strong> xử lý thay vì để khách tự huỷ —
            đảm bảo organizer được thông báo kịp thời và waitlist được tận dụng.
          </p>
        </div>

        {/* Quick-select presets */}
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => { setCutoff(h); setSaved(false); }}
              className={[
                "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                cutoff === h
                  ? "border-nq-primary/60 bg-nq-primary/10 text-nq-primary"
                  : "border-nq-border/40 text-nq-muted hover:text-nq-foreground",
              ].join(" ")}
            >
              {h}h
            </button>
          ))}

          {/* Custom value */}
          <div className="flex h-8 items-center gap-1 rounded-lg border border-nq-border/40 bg-nq-bg px-2.5">
            <input
              type="number"
              min={0}
              max={72}
              value={cutoff}
              onChange={(e) => { setCutoff(Number(e.target.value)); setSaved(false); }}
              className="w-10 bg-transparent text-sm text-nq-foreground focus:outline-none"
              aria-label="Số giờ tuỳ chỉnh"
            />
            <span className="text-xs text-nq-muted">giờ</span>
          </div>
        </div>

        {/* Explanation of what happens */}
        <div className="rounded-xl border border-nq-border/20 bg-nq-surface/30 px-3 py-2.5 text-xs text-nq-muted space-y-1">
          <p>
            <span className="text-nq-foreground font-medium">Còn trên {cutoff}h: </span>
            Thành viên tự báo vắng qua link → slot mở lại → Organizer nhận SMS ngay.
          </p>
          <p>
            <span className="text-nq-foreground font-medium">Còn dưới {cutoff}h: </span>
            Minh nhận yêu cầu → SMS organizer ngay → kiểm tra waitlist → đề xuất hướng xử lý.
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-nq-border/30 pt-3">
          {error && <p role="alert" className="text-xs text-nq-error">{error}</p>}
          {saved && <p role="status" className="text-xs text-nq-success">Đã lưu!</p>}
          <Button type="button" variant="primary" size="sm" onClick={handleSave} disabled={isPending}>
            {isPending ? "Đang lưu…" : "Lưu cài đặt"}
          </Button>
        </div>
      </fieldset>
    </Card>
  );
}
