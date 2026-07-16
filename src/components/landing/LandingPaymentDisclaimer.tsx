"use client";

/**
 * "Payment Provider Notice" — legally-important callout that Square,
 * Clover, Toast etc. are independent third parties and NailIQ does
 * not hold salon funds. Presented as an inline note so it stays
 * visible without derailing the sales flow.
 */
import { useMemo } from "react";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function LandingPaymentDisclaimer() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.paymentDisclaimer,
    [language],
  );

  return (
    <section className="relative bg-nq-bg py-10 md:py-14">
      <div className="mx-auto w-full max-w-5xl px-5 md:px-8">
        <motion.aside
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="rounded-2xl border border-nq-border/30 bg-nq-surface/30 p-6 md:p-8"
          aria-labelledby="payment-disclaimer-title"
        >
          <p className="text-[11px] font-semibold tracking-[0.24em] text-nq-muted uppercase">
            {t.eyebrow}
          </p>
          <h2
            id="payment-disclaimer-title"
            className="mt-3 text-xl font-semibold text-nq-foreground md:text-2xl"
          >
            {t.title}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-nq-muted/85 md:text-base">
            {t.body}
          </p>
          <p className="mt-3 text-sm leading-relaxed text-nq-primary-soft/80 md:text-base">
            {t.squareNote}
          </p>
        </motion.aside>
      </div>
    </section>
  );
}
