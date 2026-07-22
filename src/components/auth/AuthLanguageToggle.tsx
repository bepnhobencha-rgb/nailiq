"use client";

import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { cn } from "@/shared/lib/cn";

/**
 * Compact EN/VI pill for the auth shell. Reads/writes the same
 * `useUserLanguage` source as the marketing navbar so the user's pick
 * persists across `/login` ↔ `/register` ↔ `/`.
 */
export function AuthLanguageToggle() {
  const { language, setLanguage } = useUserLanguage();

  return (
    <div
      role="group"
      aria-label="Language"
      className="inline-flex items-center rounded-full border border-nq-border/40 bg-nq-surface/40 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
    >
      {(["en", "vi"] as const).map((code) => {
        const active = language === code;
        return (
          <button
            key={code}
            type="button"
            onClick={() => setLanguage(code)}
            className={cn(
              "min-h-11 min-w-11 rounded-full px-3 py-2 text-lg transition-[color,background-color,box-shadow,transform] duration-200 active:scale-95",
              active
                ? "bg-nq-primary/15 text-nq-primary-soft shadow-[inset_0_0_0_1px_rgba(212,175,55,0.25)]"
                : "text-nq-muted hover:text-nq-foreground",
            )}
            aria-pressed={active}
            aria-label={code === "vi" ? "Tiếng Việt" : "English"}
          >
            <span aria-hidden>{code === "vi" ? "🇻🇳" : "🇨🇦"}</span>
            <span className="sr-only">
              {code === "vi" ? "Tiếng Việt" : "English"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
