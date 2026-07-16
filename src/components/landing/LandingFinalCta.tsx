"use client";

import Link from "next/link";
import { useMemo } from "react";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function LandingFinalCta() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.finalCta,
    [language],
  );

  return (
    <section className="relative bg-nq-bg pt-6 pb-14 md:pt-10 md:pb-20">
      <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 24 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="relative overflow-hidden rounded-3xl border border-nq-primary/30 px-6 py-12 text-center md:px-12 md:py-16"
          style={{
            background:
              "radial-gradient(circle at 30% 0%, rgba(212,175,55,0.18) 0%, rgba(212,175,55,0.05) 35%, transparent 70%), linear-gradient(135deg, #14110a 0%, #0b0c10 60%)",
            boxShadow:
              "0 28px 80px -32px rgba(212,175,55,0.35), inset 0 0 0 1px rgba(212,175,55,0.08)",
          }}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute -left-20 -top-32 h-[360px] w-[360px] rounded-full bg-nq-primary/[0.08] blur-3xl"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute -bottom-32 -right-20 h-[360px] w-[360px] rounded-full bg-nq-primary/[0.06] blur-3xl"
          />

          <p className="relative text-[11px] font-semibold tracking-[0.24em] text-nq-primary uppercase">
            {t.eyebrow}
          </p>
          <h2 className="relative mt-4 text-balance text-3xl font-semibold tracking-tight text-nq-foreground md:text-4xl lg:text-5xl">
            {t.h2}
          </h2>
          <p className="relative mx-auto mt-4 max-w-2xl text-base text-nq-muted/85 md:text-lg">
            {t.body}
          </p>
          <p className="relative mx-auto mt-3 max-w-2xl text-base text-nq-primary-soft/90 md:text-lg">
            {t.supportingLine}
          </p>

          <div className="relative mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/contact?intent=pilot"
              data-testid="final-cta-primary"
              className="inline-flex min-w-[260px] items-center justify-center rounded-full border border-nq-primary/50 bg-nq-primary px-8 py-4 text-base font-semibold text-nq-bg shadow-[0_12px_36px_-10px_rgba(212,175,55,0.65)] transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
            >
              {t.ctaPrimary}
            </Link>
            <Link
              href="/contact?intent=demo"
              data-testid="final-cta-secondary"
              className="inline-flex min-w-[220px] items-center justify-center rounded-full border border-nq-border/50 bg-nq-surface/50 px-6 py-4 text-sm font-semibold text-nq-foreground transition hover:bg-nq-surface hover:border-nq-border/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
            >
              {t.ctaSecondary}
            </Link>
          </div>

          <p className="relative mx-auto mt-6 max-w-2xl text-xs leading-relaxed text-nq-muted/70">
            {t.trustNote}
          </p>
          <p className="relative mx-auto mt-3 max-w-3xl text-[11px] leading-relaxed text-nq-muted/55">
            {t.finalLegalNote}
          </p>
        </motion.div>
      </div>
    </section>
  );
}
