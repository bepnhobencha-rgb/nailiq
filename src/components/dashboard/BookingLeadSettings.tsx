"use client";

import { useImmediateSettingSave } from "@/components/dashboard/useImmediateSettingSave";
import { Button } from "@/components/ui/Button";
import { updateBookingLeadMinutes } from "@/shared/dashboard/salonOwnerActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  initialMinutes: number;
};

// Common presets; "0" = allow booking right up to the slot time.
const PRESETS = [0, 15, 30, 60, 120] as const;

/**
 * Owner setting: minimum advance notice for same-day online bookings. Slots
 * starting sooner than now()+this are hidden from the public booking grid.
 */
export function BookingLeadSettings({ slug, initialMinutes }: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const {
    value: minutes,
    status,
    isSaving,
    change,
  } = useImmediateSettingSave({
    initialValue: initialMinutes,
    save: async (next) => {
      const res = await updateBookingLeadMinutes(slug, next);
      return res.ok
        ? { ok: true, value: res.minutes }
        : { ok: false };
    },
  });

  const label = (m: number) =>
    m === 0
      ? vi ? "Không" : "None"
      : m >= 60
        ? vi ? `${m / 60} giờ` : `${m / 60}h`
        : `${m} ${vi ? "phút" : "min"}`;

  return (
    <section
      data-testid="settings-booking-lead"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <p className="text-sm font-semibold text-nq-foreground">
        {vi ? "Đặt trước tối thiểu" : "Minimum advance notice"}
      </p>
      <p className="mt-0.5 text-xs text-nq-muted">
        {vi
          ? "Khách không đặt được khung giờ bắt đầu trong khoảng này tính từ bây giờ (để thợ kịp chuẩn bị)."
          : "Customers can't book a slot starting within this window from now (gives staff prep time)."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS.map((m) => {
          const on = minutes === m;
          return (
            <Button
              key={m}
              variant={on ? "primary" : "secondary"}
              size="md"
              aria-pressed={on}
              disabled={isSaving}
              onClick={() => change(m)}
            >
              {label(m)}
            </Button>
          );
        })}
      </div>
      <p
        data-testid="settings-booking-lead-save-status"
        className={`mt-3 min-h-5 text-sm ${
          status === "error"
            ? "text-nq-error"
            : status === "saved"
              ? "text-nq-success"
              : "text-nq-muted"
        }`}
        role="status"
        aria-live="polite"
      >
        {status === "saving"
          ? vi
            ? "Đang lưu…"
            : "Saving…"
          : status === "saved"
            ? vi
              ? "✓ Đã lưu"
              : "✓ Saved"
            : status === "error"
              ? vi
                ? "Không thể lưu. Chọn lại để thử lại."
                : "Could not save. Select again to retry."
              : vi
                ? "Tự động lưu khi bạn chọn."
                : "Saves automatically when selected."}
      </p>
    </section>
  );
}
