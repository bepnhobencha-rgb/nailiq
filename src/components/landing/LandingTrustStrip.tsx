"use client";

import { useMemo } from "react";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function LandingTrustStrip() {
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.trustStrip,
    [language],
  );

  const items = [t.made, t.pipeda, t.freeToStart, t.bilingual];

  return (
    <div className="border-y border-nq-border/20 bg-nq-surface/20 py-3">
      <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
        <ul className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2">
          {items.map((label) => (
            <li
              key={label}
              className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-nq-muted/80"
            >
              <span
                aria-hidden
                className="h-1 w-1 rounded-full bg-nq-primary/50"
              />
              {label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
