"use client";

import Link from "next/link";
import { useMemo } from "react";
import { cn } from "@/shared/lib/cn";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import type { UserLanguage } from "@/shared/i18n/user/types";

export function LandingFooter() {
  // Use the real shared toggle so the choice persists across pages and
  // matches the nav. Was previously a local useState (cosmetic only).
  const { language: lang, setLanguage: setLang } = useUserLanguage();
  const messages = useMemo(() => getUserMessages(lang), [lang]);
  const t = messages.landing.footer;
  const navT = messages.landing.nav;

  return (
    <footer className="border-t border-nq-border/30 bg-nq-bg py-6 md:py-8">
      <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="landing-html-wordmark-wrap inline-flex items-baseline focus-visible:outline-none"
              aria-label="NailIQ home"
            >
              <span className="landing-html-wordmark text-lg tracking-tight">
                <span className="landing-html-wordmark-nail">Nail</span>
                <span className="landing-html-wordmark-iq">IQ</span>
              </span>
            </Link>
            <span className="text-sm text-nq-muted">© 2026</span>
          </div>

          <nav
            aria-label="Footer"
            className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-nq-muted"
          >
            <Link
              href="/privacy"
              className="transition hover:text-nq-foreground focus-visible:outline-none focus-visible:text-nq-foreground"
            >
              {t.privacy}
            </Link>
            <Link
              href="/terms"
              className="transition hover:text-nq-foreground focus-visible:outline-none focus-visible:text-nq-foreground"
            >
              {t.terms}
            </Link>
            <Link
              href="/contact"
              className="transition hover:text-nq-foreground focus-visible:outline-none focus-visible:text-nq-foreground"
            >
              {t.contact}
            </Link>
          </nav>
        </div>

        <div className="mt-4 flex flex-col gap-3 md:mt-5 md:flex-row md:items-center md:justify-between">
          <FooterLangToggle
            lang={lang}
            setLang={setLang}
            ariaLabel={navT.langAriaLabel}
          />
          <p className="text-xs text-nq-muted">{t.builtIn}</p>
        </div>
      </div>
    </footer>
  );
}

function FooterLangToggle({
  lang,
  setLang,
  ariaLabel,
}: {
  lang: UserLanguage;
  setLang: (l: UserLanguage) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex w-fit items-center rounded-full border border-nq-border/40 bg-nq-surface/40 p-1 text-[11px] font-semibold tracking-widest uppercase"
    >
      {(["en", "vi"] as const).map((code) => {
        const active = lang === code;
        return (
          <button
            key={code}
            type="button"
            onClick={() => setLang(code)}
            className={cn(
              "min-w-9 rounded-full px-3 py-1 transition",
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
