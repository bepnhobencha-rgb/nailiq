"use client";

import { useState, useTransition } from "react";
import { updateWinBackEnabled } from "@/shared/dashboard/salonOwnerActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  initialEnabled: boolean;
};

/**
 * Owner toggle: send a friendly "we missed you — rebook" email after a no-show
 * (retention over penalty). On by default.
 */
export function WinBackSettings({ slug, initialEnabled }: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [on, setOn] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next);
    startTransition(async () => {
      const res = await updateWinBackEnabled(slug, next);
      if (!res.ok) setOn(!next);
    });
  }

  return (
    <section
      data-testid="settings-winback"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-nq-foreground">
            {vi ? "Email kéo khách lại sau no-show" : "Win-back email after a no-show"}
          </p>
          <p className="mt-0.5 text-xs text-nq-muted">
            {vi
              ? "Khi đánh dấu vắng, tự gửi email thân thiện “Tụi mình nhớ bạn — đặt lại nhé” kèm link đặt 1 chạm. Giữ khách thay vì mất luôn."
              : "When you mark a no-show, automatically email a friendly “we missed you — rebook” note with a one-tap link. Retain the guest instead of losing them."}
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
