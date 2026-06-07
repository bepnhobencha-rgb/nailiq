"use client";

import { useState, useTransition } from "react";
import { updateReferenceImageEnabled } from "@/shared/dashboard/salonOwnerActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  /** Effective current value (salon override resolved against the vertical default). */
  initialEnabled: boolean;
};

/**
 * Owner toggle: whether the booking flow offers the optional "reference image"
 * upload. Default follows the vertical (nail = on, head spa = off); this writes
 * an explicit override.
 */
export function ReferenceImageSettings({ slug, initialEnabled }: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [on, setOn] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next);
    startTransition(async () => {
      const res = await updateReferenceImageEnabled(slug, next);
      if (!res.ok) setOn(!next); // revert on failure
    });
  }

  return (
    <section
      data-testid="settings-reference-image"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-nq-foreground">
            {vi ? "Cho khách tải ảnh tham khảo" : "Let customers upload a reference photo"}
          </p>
          <p className="mt-0.5 text-xs text-nq-muted">
            {vi
              ? "Hợp dịch vụ tạo hình (nail/tóc) — khách cho xem kiểu muốn. Head spa/massage thường tắt."
              : "Useful for visual services (nail/hair) — customers show the look they want. Usually off for head spa/massage."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          disabled={pending}
          onClick={toggle}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            on ? "bg-nq-primary" : "bg-white/15"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
              on ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
    </section>
  );
}
