"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/shared/lib/cn";

/**
 * P0.1 — small EN/VI toggle rendered in the booking page header.
 *
 * Writes a long-lived cookie (`nq-booking-lang`) that the server
 * page consumes via `resolveBookingLanguage`. The booking route is
 * `force-dynamic`, so `router.refresh()` after the cookie flips
 * re-renders the page in the chosen language.
 *
 * Booking page is the only surface that uses this — the dashboard
 * has its own `useUserLanguage` story under a separate cookie. Two
 * audiences, two preferences.
 */
export function BookingLanguageToggle({
  currentLang,
}: {
  currentLang: "en" | "vi";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const setLang = (lang: "en" | "vi") => {
    if (lang === currentLang || pending) return;
    // ~1 year expiry; SameSite=Lax is enough for first-party reads
    // on the same origin. Cookie is non-HTTP-only by design so the
    // client tier can read it for SSR hydration consistency.
    document.cookie = `nq-booking-lang=${lang}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <div
      data-testid="booking-language-toggle"
      role="group"
      aria-label="Language"
      className="inline-flex items-center rounded-full border border-white/20 bg-black/30 p-0.5 text-[11px] font-semibold uppercase tracking-wide backdrop-blur-sm"
    >
      {(["vi", "en"] as const).map((lang) => {
        const active = currentLang === lang;
        return (
          <button
            key={lang}
            type="button"
            data-testid={`booking-language-${lang}`}
            aria-pressed={active}
            disabled={pending}
            onClick={() => setLang(lang)}
            className={cn(
              "min-w-9 rounded-full px-2.5 py-1 transition-colors",
              active
                ? "bg-white text-black"
                : "text-white/75 hover:text-white",
              pending && "opacity-60",
            )}
          >
            {lang === "vi" ? "VI" : "EN"}
          </button>
        );
      })}
    </div>
  );
}
