"use client";

/**
 * Founder Pilot pricing — 2 cards (Monthly + Annual). Was the 4-tier
 * SaaS pricing grid; the pilot has a single fixed scope + two
 * payment shapes. Kept the file name and exported symbol so
 * `src/app/page.tsx` doesn't need to rename imports.
 *
 * CTAs go to `/contact?intent=pilot&plan=<monthly|annual>` — the
 * contact form reads the `plan` query param and preselects it in
 * the "Preferred option" field. There is no in-flow checkout for
 * the pilot: every applicant is reviewed manually.
 */
import Link from "next/link";
import { useMemo } from "react";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { cn } from "@/shared/lib/cn";

function CheckIcon({ muted }: { muted?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
        muted
          ? "bg-nq-foreground/[0.07] text-nq-muted"
          : "bg-nq-primary/20 text-nq-primary",
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3 w-3"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  );
}

export function LandingPricing() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.pricing,
    [language],
  );

  return (
    <section className="relative bg-nq-bg py-14 md:py-20">
      <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="text-center"
        >
          <p className="text-[11px] font-semibold tracking-[0.24em] text-nq-primary uppercase">
            {t.eyebrow}
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-nq-foreground md:text-4xl lg:text-5xl">
            {t.h2}
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-base text-nq-muted/80 md:text-lg">
            {t.sub}
          </p>
        </motion.div>

        <div className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-6 md:grid-cols-2 md:items-stretch md:gap-7">
          {/* Monthly card */}
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 24 }}
            whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            className="relative flex flex-col"
          >
            <div className="relative flex flex-1 flex-col rounded-3xl border border-nq-border/30 bg-nq-surface/50 p-6 md:p-8">
              <div className="h-[26px]" aria-hidden />
              <p className="text-xs font-semibold uppercase tracking-widest text-nq-muted">
                {t.monthly.name}
              </p>

              <div className="mt-3 flex flex-wrap items-baseline gap-2">
                <span className="text-4xl font-bold tracking-tight text-nq-foreground md:text-5xl">
                  {t.monthly.setupPrice}
                </span>
                <span className="text-sm text-nq-muted">{t.setupLabel}</span>
              </div>
              <p className="mt-2 text-xs uppercase tracking-widest text-nq-muted/70">
                {t.plusLabel}
              </p>
              <div className="mt-1 flex flex-wrap items-baseline gap-2">
                <span className="text-3xl font-bold tracking-tight text-nq-foreground md:text-4xl">
                  {t.monthly.monthlyPrice}
                </span>
                <span className="text-sm text-nq-muted">{t.perMonthLabel}</span>
              </div>

              <p className="mt-3 text-sm font-medium text-nq-primary-soft/90">
                {t.monthly.commitment}
              </p>

              <ul className="mt-6 flex-1 space-y-2.5">
                {t.monthly.included.map((f) => (
                  <li
                    key={f}
                    className="flex items-start gap-2.5 text-sm text-nq-foreground"
                  >
                    <CheckIcon muted />
                    <span className="leading-relaxed">{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-7">
                <Link
                  href="/contact?intent=pilot&plan=monthly"
                  data-testid="pricing-cta-monthly"
                  className="inline-flex w-full items-center justify-center rounded-full border border-nq-border/50 bg-nq-surface/60 px-6 py-3 text-sm font-semibold text-nq-foreground transition hover:bg-nq-surface hover:border-nq-border/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
                >
                  {t.monthly.cta}
                </Link>
                <p className="mt-3 text-center text-xs leading-snug text-nq-muted/75">
                  {t.monthly.commitmentNote}
                </p>
              </div>
            </div>
          </motion.div>

          {/* Annual card — BEST VALUE */}
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 24 }}
            whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{
              duration: 0.55,
              delay: 0.08,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="relative flex flex-col"
          >
            {/* Ambient gold glow */}
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-3 rounded-[28px] bg-gradient-to-br from-nq-primary/20 via-transparent to-nq-primary/10 blur-2xl"
            />

            <div className="relative flex flex-1 flex-col rounded-3xl border-2 border-nq-primary/60 bg-gradient-to-b from-nq-surface/70 to-nq-bg/40 p-6 shadow-[0_30px_80px_-30px_rgba(212,175,55,0.35)] md:p-8">
              <span className="inline-flex w-fit items-center rounded-full border border-nq-primary/40 bg-nq-primary/15 px-3 py-1 text-[10px] font-bold tracking-[0.18em] text-nq-primary uppercase">
                {t.annual.badge}
              </span>

              <p className="mt-4 text-xs font-semibold uppercase tracking-widest text-nq-muted">
                {t.annual.name}
              </p>

              <div className="mt-3 flex flex-wrap items-baseline gap-2">
                <span className="text-5xl font-bold tracking-tight text-nq-foreground md:text-6xl">
                  {t.annual.price}
                </span>
              </div>
              <p className="mt-2 text-sm text-nq-primary-soft/90">
                {t.annual.description}
              </p>

              <p className="mt-4 text-sm font-medium text-nq-primary">
                {t.annual.savingsLine}
              </p>

              <ul className="mt-6 flex-1 space-y-2.5">
                {t.annual.included.map((f) => (
                  <li
                    key={f}
                    className="flex items-start gap-2.5 text-sm text-nq-foreground"
                  >
                    <CheckIcon />
                    <span className="leading-relaxed">{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-7">
                <Link
                  href="/contact?intent=pilot&plan=annual"
                  data-testid="pricing-cta-annual"
                  className="inline-flex w-full items-center justify-center rounded-full border border-nq-primary/50 bg-nq-primary px-6 py-3.5 text-sm font-semibold text-nq-bg shadow-[0_8px_28px_-8px_rgba(212,175,55,0.55)] transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
                >
                  {t.annual.cta}
                </Link>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
