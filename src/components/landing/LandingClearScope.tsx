"use client";

/**
 * "Clear Pricing. No Hidden Promises." — the exhaustive out-of-scope
 * list plus support-hour pricing. Kept dense because the whole point
 * of this section is to prevent later surprise invoices; owners see
 * exactly what is NOT included before applying.
 */
import { useMemo } from "react";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function LandingClearScope() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.clearScope,
    [language],
  );

  return (
    <section className="relative bg-nq-bg py-14 md:py-20">
      <div className="mx-auto w-full max-w-5xl px-5 md:px-8">
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

        <div className="mt-10 rounded-2xl border border-nq-border/30 bg-nq-surface/40 p-6 md:p-8">
          <h3 className="text-sm font-semibold uppercase tracking-widest text-nq-muted">
            {t.notIncludedTitle}
          </h3>
          <ul className="mt-5 grid gap-1.5 sm:grid-cols-2 md:gap-2 lg:grid-cols-3">
            {t.items.map((item) => (
              <li
                key={item}
                className="flex items-start gap-2 text-sm text-nq-foreground/80"
              >
                <span
                  aria-hidden
                  className="mt-2 inline-block h-1 w-1 shrink-0 rounded-full bg-nq-muted/60"
                />
                <span className="leading-relaxed">{item}</span>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm leading-relaxed text-nq-primary-soft/90 md:text-base">
            {t.closing}
          </p>
        </div>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/40 p-6 md:p-7"
        >
          <h3 className="text-sm font-semibold uppercase tracking-widest text-nq-muted">
            {t.supportPricingTitle}
          </h3>
          <p className="mt-3 text-sm leading-relaxed text-nq-foreground/85 md:text-base">
            {t.supportPricing}
          </p>
        </motion.div>
      </div>
    </section>
  );
}
