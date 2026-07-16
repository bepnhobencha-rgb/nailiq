"use client";

/**
 * Founder Pilot "How It Works" section — 4 numbered steps + a
 * timeline note. Was 3 steps in the pre-pilot layout; the pilot
 * flow adds a Review-and-Test step before Go-Live because the salon
 * has to sign off before we schedule training.
 */
import Link from "next/link";
import { useMemo } from "react";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function LandingHowItWorks() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.howItWorks,
    [language],
  );

  const steps = useMemo(
    () => [t.step1, t.step2, t.step3, t.step4],
    [t.step1, t.step2, t.step3, t.step4],
  );

  return (
    <section
      id="how-it-works"
      className="relative bg-nq-bg py-14 md:py-20"
    >
      <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="text-[11px] font-semibold tracking-[0.24em] text-nq-primary uppercase">
            {t.eyebrow}
          </p>
          <h2 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight text-nq-foreground md:text-4xl lg:text-5xl">
            {t.h2}
          </h2>
        </motion.div>

        <ol className="mt-12 grid gap-5 md:grid-cols-2 md:gap-6 lg:grid-cols-4">
          {steps.map((step, i) => (
            <motion.li
              key={step.title}
              initial={reduce ? false : { opacity: 0, y: 24 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{
                duration: 0.5,
                delay: 0.05 + i * 0.06,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="relative flex flex-col rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-6 md:p-7"
            >
              <span
                aria-hidden
                className="text-4xl font-bold tabular-nums text-nq-primary md:text-5xl"
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-3 text-lg font-semibold text-nq-foreground md:text-xl">
                {step.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-nq-muted/85">
                {step.body}
              </p>
              <ul className="mt-4 space-y-1.5">
                {step.list.map((l) => (
                  <li
                    key={l}
                    className="flex items-start gap-2 text-xs text-nq-foreground/80 md:text-sm"
                  >
                    <span
                      aria-hidden
                      className="mt-2 inline-block h-1 w-1 shrink-0 rounded-full bg-nq-primary/70"
                    />
                    <span className="leading-relaxed">{l}</span>
                  </li>
                ))}
              </ul>
            </motion.li>
          ))}
        </ol>

        <motion.p
          initial={reduce ? false : { opacity: 0, y: 12 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="mt-8 max-w-3xl text-sm leading-relaxed text-nq-muted/80 md:text-base"
        >
          {t.timelineNote}
        </motion.p>

        <div className="mt-8">
          <Link
            href="/contact?intent=pilot"
            className="inline-flex items-center justify-center rounded-full border border-nq-primary/50 bg-nq-primary px-6 py-3 text-sm font-semibold text-nq-bg shadow-[0_8px_28px_-8px_rgba(212,175,55,0.55)] transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
          >
            {t.bottomCta}
          </Link>
        </div>
      </div>
    </section>
  );
}
