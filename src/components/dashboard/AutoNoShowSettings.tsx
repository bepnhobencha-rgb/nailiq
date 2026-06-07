"use client";

import { useState, useTransition } from "react";
import { updateAutoNoShowMinutes } from "@/shared/dashboard/salonOwnerActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  initialMinutes: number;
};

// 0 = off; otherwise grace minutes past start before auto-marking no-show.
const PRESETS = [0, 15, 30, 60] as const;

/**
 * Owner setting: auto-mark a booking as no-show when it's this many minutes past
 * its start and still un-started. A background job runs every 10 min. Off by
 * default — opting in means the salon trusts "started" to be marked promptly.
 */
export function AutoNoShowSettings({ slug, initialMinutes }: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [minutes, setMinutes] = useState(initialMinutes);
  const [pending, startTransition] = useTransition();

  function change(next: number) {
    const prev = minutes;
    setMinutes(next);
    startTransition(async () => {
      const res = await updateAutoNoShowMinutes(slug, next);
      if (!res.ok) setMinutes(prev);
    });
  }

  const label = (m: number) =>
    m === 0 ? (vi ? "Tắt" : "Off") : `${m} ${vi ? "phút" : "min"}`;

  return (
    <section
      data-testid="settings-auto-no-show"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <p className="text-sm font-semibold text-nq-foreground">
        {vi ? "Tự động đánh dấu vắng (no-show)" : "Auto-mark no-shows"}
      </p>
      <p className="mt-0.5 text-xs text-nq-muted">
        {vi
          ? "Lịch quá giờ bắt đầu chừng này phút mà CHƯA bắt đầu (chưa bấm “Đang làm”) sẽ tự đánh dấu vắng + giải phóng giường. Chạy nền mỗi 10 phút. Nhớ bấm “Đang làm/Đã đến” khi khách tới để tránh đánh dấu nhầm."
          : "A booking still un-started this long after its start time is auto-marked no-show + frees the bed. Runs every 10 min. Mark arrivals as started so real guests aren't flagged."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS.map((m) => {
          const on = minutes === m;
          return (
            <button
              key={m}
              type="button"
              disabled={pending}
              onClick={() => change(m)}
              className={`rounded-full border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                on
                  ? "border-nq-primary bg-nq-primary/15 text-nq-primary"
                  : "border-nq-border/40 text-nq-muted hover:border-nq-primary/40"
              }`}
            >
              {label(m)}
            </button>
          );
        })}
      </div>
    </section>
  );
}
