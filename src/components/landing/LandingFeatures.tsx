"use client";

/**
 * Founder Pilot "Done-For-You Salon Setup" section — was originally
 * a 3-card feature grid (Booking / Queue / Center). Now renders the
 * 7-item Done-For-You list from `landing.doneForYou.items`, each
 * with a title + short body + sub-bullets.
 *
 * File name kept for lower diff churn; component exports the same
 * `LandingFeatures` symbol so `src/app/page.tsx` doesn't need to
 * rename its imports.
 */
import { useMemo } from "react";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function LandingFeatures() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.doneForYou,
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
        >
          <p className="text-[11px] font-semibold tracking-[0.24em] text-nq-primary uppercase">
            {t.eyebrow}
          </p>
          <h2 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight text-nq-foreground md:text-4xl lg:text-5xl">
            {t.h2}
          </h2>
        </motion.div>

        <div className="mt-12 grid gap-5 md:grid-cols-2 md:gap-6 lg:grid-cols-3">
          {t.items.map((item, i) => (
            <motion.article
              key={item.title}
              initial={reduce ? false : { opacity: 0, y: 24 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{
                duration: 0.5,
                delay: 0.04 + (i % 3) * 0.05,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="nq-feature-card group relative flex flex-col p-6 md:p-7"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-nq-primary/30 bg-nq-primary/10 text-nq-primary">
                <span className="text-sm font-bold tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 className="mt-5 text-lg font-semibold text-nq-foreground md:text-xl">
                {item.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-nq-muted/85">
                {item.body}
              </p>
              <ul className="mt-4 space-y-1.5">
                {item.bullets.map((b) => (
                  <li
                    key={b}
                    className="flex items-start gap-2 text-sm text-nq-foreground/85"
                  >
                    <span
                      aria-hidden
                      className="mt-2 inline-block h-1 w-1 shrink-0 rounded-full bg-nq-primary/80"
                    />
                    <span className="leading-relaxed">{b}</span>
                  </li>
                ))}
              </ul>
            </motion.article>
          ))}
        </div>
      </div>
    </section>
  );
}
