"use client";

import { useState, useTransition } from "react";
import { updateStaffSelectionEnabled } from "@/shared/dashboard/salonOwnerActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  initialEnabled: boolean;
};

/**
 * Owner toggle for whether customers pick a provider during booking. When OFF,
 * the wizard hides the staff step and auto-assigns any available provider.
 */
export function StaffSelectionSettings({ slug, initialEnabled }: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [on, setOn] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next);
    startTransition(async () => {
      const res = await updateStaffSelectionEnabled(slug, next);
      if (!res.ok) setOn(!next); // revert on failure
    });
  }

  return (
    <section
      data-testid="settings-staff-selection"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-nq-foreground">
            {vi ? "Cho khách chọn thợ" : "Let customers choose a provider"}
          </p>
          <p className="mt-0.5 text-xs text-nq-muted">
            {vi
              ? "Tắt → bỏ bước chọn thợ, hệ thống tự gán thợ rảnh (hợp spa)."
              : "Off → hide the provider step and auto-assign any available staff."}
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
