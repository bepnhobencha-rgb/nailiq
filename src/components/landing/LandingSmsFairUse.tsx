"use client";

/**
 * "SMS Fair Use" — inline note about the 250 segments/month
 * included with the pilot. Deliberately short: enough context for
 * the owner to understand what "segment" means and what happens if
 * they exceed the fair-use cap. No unlimited-SMS claim.
 */
import { useMemo } from "react";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function LandingSmsFairUse() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.smsFairUse,
    [language],
  );

  return (
    <section className="relative bg-nq-bg py-10 md:py-14">
      <div className="mx-auto w-full max-w-5xl px-5 md:px-8">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="rounded-2xl border border-nq-border/30 bg-nq-surface/40 p-6 md:p-8"
        >
          <p className="text-[11px] font-semibold tracking-[0.24em] text-nq-primary uppercase">
            {t.eyebrow}
          </p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-nq-foreground md:text-3xl">
            {t.h2}
          </h2>
          <p className="mt-4 text-base font-medium text-nq-primary-soft/90 md:text-lg">
            {t.included}
          </p>
          <ul className="mt-4 space-y-2">
            {t.explanations.map((e) => (
              <li
                key={e}
                className="flex items-start gap-2 text-sm leading-relaxed text-nq-foreground/80 md:text-base"
              >
                <span
                  aria-hidden
                  className="mt-2 inline-block h-1 w-1 shrink-0 rounded-full bg-nq-primary/70"
                />
                <span>{e}</span>
              </li>
            ))}
          </ul>
        </motion.div>
      </div>
    </section>
  );
}
