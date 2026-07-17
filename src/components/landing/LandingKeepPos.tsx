"use client";

/**
 * "Keep the POS You Already Use" — the multi-POS reassurance the
 * Founder Pilot page hinges on. Three cards make the scope crisp:
 * Square (connection support), Clover/Toast/other (alongside), and
 * Custom integration (out-of-scope, quote required). POS provider
 * names appear as text only — no third-party logos are rendered
 * without verified usage rights.
 */
import { useMemo } from "react";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function LandingKeepPos() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.keepPos,
    [language],
  );

  const cards = useMemo(
    () => [
      { key: "square", data: t.square, accent: true },
      { key: "other", data: t.other, accent: false },
      { key: "custom", data: t.custom, accent: false },
    ],
    [t.square, t.other, t.custom],
  );

  return (
    <section
      id="keep-your-pos"
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
          <p className="mt-4 max-w-3xl text-base leading-relaxed text-nq-muted/85 md:text-lg">
            {t.intro}
          </p>
        </motion.div>

        <div className="mt-10 grid gap-5 md:grid-cols-3 md:gap-6">
          {cards.map((c, i) => (
            <motion.article
              key={c.key}
              initial={reduce ? false : { opacity: 0, y: 24 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{
                duration: 0.5,
                delay: 0.05 + i * 0.07,
                ease: [0.22, 1, 0.36, 1],
              }}
              className={
                c.accent
                  ? "flex flex-col rounded-2xl border-2 border-nq-primary/40 bg-gradient-to-b from-nq-surface/70 to-nq-bg/40 p-6 shadow-[0_20px_60px_-30px_rgba(212,175,55,0.35)] md:p-7"
                  : "flex flex-col rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-6 md:p-7"
              }
            >
              <h3 className="text-lg font-semibold text-nq-foreground md:text-xl">
                {c.data.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-nq-muted/85 md:text-base">
                {c.data.body}
              </p>
            </motion.article>
          ))}
        </div>

        <motion.p
          initial={reduce ? false : { opacity: 0, y: 12 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="mt-8 max-w-3xl text-sm font-medium text-nq-primary-soft/90 md:text-base"
        >
          {t.trustNote}
        </motion.p>

        <p className="mt-3 max-w-3xl text-xs leading-relaxed text-nq-muted/60">
          {t.logoNote}
        </p>
      </div>
    </section>
  );
}
