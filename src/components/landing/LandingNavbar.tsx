"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/shared/lib/cn";

type Lang = "en" | "vi";

export function LandingNavbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<Lang>("en");

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const closeSheet = () => setOpen(false);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-[background-color,backdrop-filter,border-color] duration-300",
        scrolled
          ? "border-b border-nq-border/30 bg-nq-bg/80 backdrop-blur-xl backdrop-saturate-150"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <nav
        className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-4 md:px-8 md:py-5"
        aria-label="Primary"
      >
        <Link
          href="/"
          className="landing-html-wordmark-wrap inline-flex items-baseline focus-visible:outline-none"
          aria-label="NailIQ home"
        >
          <span className="landing-html-wordmark text-xl tracking-tight md:text-2xl">
            <span className="landing-html-wordmark-nail">Nail</span>
            <span className="landing-html-wordmark-iq">IQ</span>
          </span>
        </Link>

        <div className="hidden items-center gap-5 md:flex">
          <LangToggle lang={lang} setLang={setLang} />
          <Link
            href="/login"
            className="text-sm text-nq-muted transition hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg rounded-md px-2 py-1"
          >
            Sign in
          </Link>
          <Link
            href="/register"
            className="inline-flex items-center justify-center rounded-full border border-nq-primary/40 bg-nq-primary px-4 py-2 text-sm font-semibold text-nq-bg shadow-[0_2px_12px_rgba(212,175,55,0.25)] transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
          >
            Try free
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-nq-border/50 text-nq-foreground md:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
        >
          <span className="relative block h-3 w-5">
            <span
              className={cn(
                "absolute left-0 top-0 h-px w-full bg-current transition-transform",
                open ? "translate-y-[6px] rotate-45" : "",
              )}
            />
            <span
              className={cn(
                "absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-current transition-opacity",
                open ? "opacity-0" : "opacity-100",
              )}
            />
            <span
              className={cn(
                "absolute bottom-0 left-0 h-px w-full bg-current transition-transform",
                open ? "-translate-y-[6px] -rotate-45" : "",
              )}
            />
          </span>
        </button>
      </nav>

      <div
        className={cn(
          "overflow-hidden border-t border-nq-border/20 bg-nq-bg/95 backdrop-blur-xl transition-[max-height,opacity] duration-300 md:hidden",
          open ? "max-h-96 opacity-100" : "max-h-0 opacity-0",
        )}
        aria-hidden={!open}
      >
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-5 py-5">
          <LangToggle lang={lang} setLang={setLang} compact />
          <Link
            href="/login"
            onClick={closeSheet}
            className="rounded-xl border border-nq-border/40 bg-nq-surface/40 px-4 py-3 text-sm text-nq-foreground"
          >
            Sign in
          </Link>
          <Link
            href="/register"
            onClick={closeSheet}
            className="rounded-xl bg-nq-primary px-4 py-3 text-center text-sm font-semibold text-nq-bg"
          >
            Try free
          </Link>
        </div>
      </div>
    </header>
  );
}

function LangToggle({
  lang,
  setLang,
  compact = false,
}: {
  lang: Lang;
  setLang: (l: Lang) => void;
  compact?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Language"
      className={cn(
        "inline-flex items-center rounded-full border border-nq-border/40 bg-nq-surface/40 p-1 text-[11px] font-semibold tracking-widest uppercase",
        compact ? "self-start" : "",
      )}
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
