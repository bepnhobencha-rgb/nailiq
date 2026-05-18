"use client";

import Link from "next/link";
import { useMemo } from "react";
import { cn } from "@/shared/lib/cn";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import type { UserLanguage } from "@/shared/i18n/user/types";

const INSTAGRAM_URL = "https://instagram.com/nailiq.ca";
const TIKTOK_URL = "https://tiktok.com/@nailiq";

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
              href="/about"
              className="transition hover:text-nq-foreground focus-visible:outline-none focus-visible:text-nq-foreground"
            >
              {t.about}
            </Link>
            <Link
              href="/security"
              className="transition hover:text-nq-foreground focus-visible:outline-none focus-visible:text-nq-foreground"
            >
              {t.security}
            </Link>
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

          <div className="flex items-center gap-4">
            <span className="text-xs text-nq-muted/60">{t.followUs}</span>
            <a
              href={INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t.instagramAriaLabel}
              className="text-nq-muted transition hover:text-nq-primary focus-visible:outline-none focus-visible:text-nq-primary"
            >
              <InstagramIcon className="h-4 w-4" />
            </a>
            <a
              href={TIKTOK_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t.tiktokAriaLabel}
              className="text-nq-muted transition hover:text-nq-primary focus-visible:outline-none focus-visible:text-nq-primary"
            >
              <TikTokIcon className="h-4 w-4" />
            </a>
          </div>

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

function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
    </svg>
  );
}

function TikTokIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.79a8.18 8.18 0 004.77 1.52V6.79a4.85 4.85 0 01-1-.1z" />
    </svg>
  );
}
