"use client";

import Link from "next/link";
import { useMemo } from "react";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { ReceptionistMockup } from "@/components/landing/ReceptionistMockup";

export function LandingHero() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.hero,
    [language],
  );

  return (
    <section className="relative overflow-hidden pt-32 pb-16 md:pt-40 md:pb-24">
      <BackgroundGlow />

      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-5 md:px-8 xl:grid-cols-2 xl:gap-20">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={reduce ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="relative z-10"
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-nq-primary/40 bg-nq-primary/10 px-3 py-1 text-[11px] font-semibold tracking-[0.18em] text-nq-primary-soft uppercase">
            <span aria-hidden className="nq-spark-pulse">⚡</span>
            {t.eyebrow}
          </span>

          <h1 className="mt-6 text-4xl font-semibold tracking-tight text-nq-foreground md:text-5xl lg:text-6xl">
            {t.h1Line1}{" "}
            <span
              className="font-[family-name:var(--font-landing-playfair),ui-serif,Georgia,serif] italic font-bold text-nq-primary-soft"
              style={{ fontStyle: "italic" }}
            >
              {t.h1Gold}
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-lg leading-relaxed text-nq-muted/80 md:text-xl">
            {t.subline}
          </p>

          <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <Link
              href="/register"
              className="inline-flex items-center justify-center rounded-full border border-nq-primary/50 bg-nq-primary px-6 py-3.5 text-base font-semibold text-nq-bg shadow-[0_8px_28px_-8px_rgba(212,175,55,0.55)] transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
            >
              {t.ctaPrimary}
            </Link>
            <a
              href="#how-it-works"
              className="inline-flex items-center justify-center rounded-full px-4 py-3 text-sm font-medium text-nq-muted transition hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
            >
              {t.ctaSecondary}
            </a>
          </div>

          <p className="mt-4 text-xs text-nq-muted/80">{t.microtrust}</p>
        </motion.div>

        <motion.div
          initial={reduce ? false : { opacity: 0, x: 32, scale: 0.97 }}
          animate={reduce ? undefined : { opacity: 1, x: 0, scale: 1 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
          className="relative hidden xl:block"
        >
          <ReceptionistMockup reduce={reduce ?? false} />
        </motion.div>
      </div>
    </section>
  );
}

function BackgroundGlow() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-40 left-1/2 h-[640px] w-[640px] -translate-x-1/2 rounded-full bg-nq-primary/[0.07] blur-3xl" />
      <div className="absolute right-[-15%] top-1/3 h-[420px] w-[420px] rounded-full bg-nq-primary/[0.05] blur-3xl" />
      <div
        className="absolute right-[6%] top-[28%] h-[380px] w-[380px] rounded-full opacity-80 blur-2xl"
        style={{
          background:
            "radial-gradient(closest-side, rgba(212,175,55,0.16), rgba(212,175,55,0.05) 55%, rgba(212,175,55,0) 75%)",
        }}
      />
    </div>
  );
}

