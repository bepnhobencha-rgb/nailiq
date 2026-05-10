"use client";

import Link from "next/link";
import { useMemo } from "react";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Step = {
  number: string;
  title: string;
  body: string;
  /** Short "what you'll see" hint shown below the body in muted text. */
  preview: string;
};

export function LandingHowItWorks() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.howItWorks,
    [language],
  );

  const steps: Step[] = useMemo(
    () => [
      { number: "01", ...t.step1 },
      { number: "02", ...t.step2 },
      { number: "03", ...t.step3 },
    ],
    [t],
  );

  return (
    <section
      id="how-it-works"
      className="relative scroll-mt-24 bg-nq-bg py-14 md:py-20"
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
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-nq-foreground md:text-5xl lg:text-6xl">
            {t.h2}
          </h2>
        </motion.div>

        <div className="relative mt-12">
          {/* Desktop connector line behind the step circles */}
          <div
            aria-hidden
            className="nq-steps-connector pointer-events-none absolute left-[16%] right-[16%] top-[44px] hidden h-px md:block"
          />

          <div className="grid gap-10 md:grid-cols-3 md:gap-8">
            {steps.map((s, i) => (
              <motion.div
                key={s.number}
                initial={reduce ? false : { opacity: 0, y: 24 }}
                whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{
                  duration: 0.55,
                  delay: i * 0.1,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className="relative"
              >
                <div
                  className="relative inline-flex h-[88px] w-[88px] items-center justify-center rounded-2xl border border-nq-primary/25 text-[56px] font-bold leading-none tracking-tight text-nq-primary"
                  style={{
                    background:
                      "radial-gradient(closest-side, rgba(212,175,55,0.18), rgba(212,175,55,0.06) 65%, transparent 100%)",
                  }}
                >
                  <span className="[text-shadow:0_0_24px_rgba(212,175,55,0.35)]">
                    {s.number}
                  </span>
                </div>
                <h3 className="mt-5 text-xl font-semibold text-nq-foreground">
                  {s.title}
                </h3>
                <p className="mt-3 text-base leading-relaxed text-nq-muted/80">
                  {s.body}
                </p>
                <p className="mt-3 text-xs italic leading-relaxed text-nq-muted/60">
                  {s.preview}
                </p>
              </motion.div>
            ))}
          </div>
        </div>

        <motion.div
          initial={reduce ? false : { opacity: 0 }}
          whileInView={reduce ? undefined : { opacity: 1 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mt-12 flex items-center justify-center"
        >
          <Link
            href="/register"
            className="group inline-flex items-center gap-2 text-sm font-medium text-nq-primary-soft transition hover:text-nq-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg rounded-md px-2 py-1"
          >
            {t.bottomCta}
            <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
