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
      className="inline-flex items-center rounded-full border border-nq-border/40 bg-nq-surface/40 p-1 text-[11px] font-semibold tracking-widest uppercase"
    >
      {(["en", "vi"] as const).map((code) => {
        const active = language === code;
        return (
          <button
            key={code}
            type="button"
            onClick={() => setLanguage(code)}
            className={cn(
              "min-w-9 rounded-full px-2.5 py-1 transition",
              active
                ? "bg-nq-primary/15 text-nq-primary-soft shadow-[inset_0_0_0_1px_rgba(212,175,55,0.25)]"
                : "text-nq-muted hover:text-nq-foreground",
            )}
            aria-pressed={active}
          >
            {code}
          </button>
        );
      })}
    </div>
  );
}
