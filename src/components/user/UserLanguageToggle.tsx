"use client";

import { Check } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import type { UserLanguage } from "@/shared/i18n/user/types";

const items: { code: UserLanguage; label: string; flag: string }[] = [
  { code: "en", label: "English", flag: "🇨🇦" },
  { code: "vi", label: "Tiếng Việt", flag: "🇻🇳" },
];

export function UserLanguageToggle({
  language,
  onLanguageChange,
  className,
  variant = "compact",
}: {
  language: UserLanguage;
  onLanguageChange: (next: UserLanguage) => void;
  className?: string;
  variant?: "compact" | "menu";
}) {
  if (variant === "menu") {
    return (
      <div
        className={cn("grid w-full grid-cols-2 gap-2", className)}
        role="group"
        aria-label={language === "vi" ? "Ngôn ngữ" : "Language"}
        data-testid="user-language-menu"
      >
        {items.map(({ code, label }) => {
          const active = language === code;
          return (
            <button
              key={code}
              type="button"
              onClick={() => onLanguageChange(code)}
              className={cn(
                "flex min-h-11 items-center justify-between gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
                active
                  ? "border-nq-primary/45 bg-nq-primary/15 text-nq-primary"
                  : "border-nq-border/40 bg-nq-bg/45 text-nq-foreground hover:bg-nq-surface/80",
              )}
              aria-label={label}
              aria-pressed={active}
            >
              <span>{label}</span>
              {active ? (
                <Check className="h-4 w-4 shrink-0" aria-hidden />
              ) : null}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-0 rounded-full border border-white/[0.08] bg-nq-bg/45 p-1 text-[11px] font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl backdrop-saturate-150",
        className,
      )}
      role="group"
      aria-label="Language"
      data-testid="user-language-toggle"
    >
      {items.map(({ code, label, flag }) => {
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
              aria-label={label}
              aria-pressed={active}
          >
            <span aria-hidden className="text-base leading-none">{flag}</span>
            <span className="sr-only">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
