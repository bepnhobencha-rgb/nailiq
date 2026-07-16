"use client";

/**
 * "Why Join the Founder Pilot?" — bullet list of pilot-only benefits
 * plus a renewal-pricing notice. Sits between the FAQ and the final
 * CTA to reinforce the value of applying now.
 */
import { useMemo } from "react";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function LandingWhyJoin() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.whyJoin,
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

        <ul className="mt-10 grid gap-3 md:grid-cols-2 md:gap-4">
          {t.items.map((item, i) => (
            <motion.li
              key={item}
              initial={reduce ? false : { opacity: 0, y: 16 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{
                duration: 0.45,
                delay: 0.04 + i * 0.04,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="flex items-start gap-3 rounded-xl border border-nq-border/30 bg-nq-surface/40 p-4 md:p-5"
            >
              <span
                aria-hidden
                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-nq-primary/15 text-nq-primary"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-3.5 w-3.5"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
              <span className="text-sm leading-relaxed text-nq-foreground/90 md:text-base">
                {item}
              </span>
            </motion.li>
          ))}
        </ul>

        <p className="mt-6 text-xs leading-relaxed text-nq-muted/70 md:text-sm">
          {t.renewalNotice}
        </p>
      </div>
    </section>
  );
}
