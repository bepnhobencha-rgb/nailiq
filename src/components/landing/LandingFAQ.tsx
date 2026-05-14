"use client";

import { useMemo } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function LandingFAQ() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.faq,
    [language],
  );

  return (
    <section id="faq" className="relative bg-nq-bg py-14 md:py-20">
      <div className="mx-auto w-full max-w-3xl px-5 md:px-8">
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
          <p className="mt-3 text-base text-nq-muted/80 md:text-lg">{t.sub}</p>
        </motion.div>

        <ul className="mt-10 space-y-3">
          {t.items.map((item, i) => (
            <motion.li
              key={item.q}
              initial={reduce ? false : { opacity: 0, y: 16 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{
                duration: 0.5,
                delay: i * 0.04,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              <details className="group rounded-2xl border border-nq-border/40 bg-nq-surface/40 px-5 py-4 transition-colors open:border-nq-primary/40 open:bg-nq-surface/60 md:px-6 md:py-5">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-4 text-left text-base font-medium text-nq-foreground md:text-lg">
                  <span>{item.q}</span>
                  <span
                    aria-hidden
                    className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-nq-border/40 text-nq-muted transition-transform group-open:rotate-45 group-open:border-nq-primary/60 group-open:text-nq-primary"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-3 w-3"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </span>
                </summary>
                <p className="mt-4 text-sm leading-relaxed text-nq-muted md:text-base">
                  {item.a}
                </p>
              </details>
            </motion.li>
          ))}
        </ul>

        <p className="mt-10 text-center text-sm text-nq-muted">
          {t.footerText}{" "}
          <Link
            href="/contact"
            className="font-semibold text-nq-primary-soft underline-offset-4 hover:underline"
          >
            {t.footerCta}
          </Link>
        </p>
      </div>
    </section>
  );
}
