"use client";

import { useState, useTransition } from "react";
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
  const [minutes, setMinutes] = useState(initialMinutes);
  const [pending, startTransition] = useTransition();

  function change(next: number) {
    const prev = minutes;
    setMinutes(next);
    startTransition(async () => {
      const res = await updateBookingLeadMinutes(slug, next);
      if (!res.ok) setMinutes(prev); // revert on failure
    });
  }

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
