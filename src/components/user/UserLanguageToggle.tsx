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
        "inline-flex items-center gap-0 rounded-lg border border-nq-border/60 bg-nq-surface/60 p-0.5 text-xs font-semibold",
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
              "min-h-9 min-w-10 rounded-md px-2.5 transition-colors",
              active
                ? "bg-nq-primary/20 text-nq-foreground"
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
