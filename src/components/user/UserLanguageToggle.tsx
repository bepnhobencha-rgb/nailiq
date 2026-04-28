"use client";

import { cn } from "@/shared/lib/cn";
import type { UserLanguage } from "@/shared/i18n/user/types";

const items: { code: UserLanguage; label: string }[] = [
  { code: "en", label: "EN" },
  { code: "vi", label: "VI" },
];

export function UserLanguageToggle({
  language,
  onLanguageChange,
  className,
}: {
  language: UserLanguage;
  onLanguageChange: (next: UserLanguage) => void;
  className?: string;
}) {

  return (
    <div
      className={cn(
        "inline-flex items-center gap-0 rounded-full border border-white/[0.08] bg-nq-bg/45 p-1 text-[11px] font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl backdrop-saturate-150",
        className,
      )}
      role="group"
      aria-label="Language"
    >
      {items.map(({ code, label }) => {
        const active = language === code;
        return (
          <button
            key={code}
            type="button"
            onClick={() => onLanguageChange(code)}
            className={cn(
              "min-h-8 min-w-9 rounded-full px-3 transition-[color,background-color,box-shadow] duration-200 ease-out",
              active
                ? "bg-white/[0.12] text-nq-foreground shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
                : "text-nq-muted hover:text-nq-primary-soft",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
