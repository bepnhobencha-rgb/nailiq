"use client";

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
      <div className="mx-auto w-full max-w-7xl px-5 md:px-8">
        {/* Section header */}
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
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-nq-foreground md:text-5xl">
            {t.h2}
          </h2>
          <p className="mt-3 text-base text-nq-muted/80 md:text-lg">
            {t.sub}
          </p>
        </motion.div>

        {/* Plans grid — 1-col mobile, 2-col md, 4-col lg.
            Task #10 (pricing v2) — was 3-col; expanded to 4 to fit
            Enterprise. Pro keeps the gold glow even at 4 cards because
            the conditional border + ambient layer do the heavy lift. */}
        <div className="mt-10 grid grid-cols-1 gap-5 md:grid-cols-2 md:items-stretch lg:grid-cols-4 lg:gap-6">
          {t.plans.map((plan, i) => {
            const isPro = plan.id === "pro";
            const isEnterprise = plan.id === "enterprise";

            return (
              <motion.div
                key={plan.id}
                initial={reduce ? false : { opacity: 0, y: 24 }}
                whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{
                  duration: 0.55,
                  delay: 0.05 + i * 0.08,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className="relative flex flex-col"
              >
                {/* Ambient glow — Pro only */}
                {isPro && (
                  <div
                    aria-hidden
                    className="absolute -inset-3 rounded-[28px] bg-gradient-to-br from-nq-primary/20 via-transparent to-nq-primary/10 blur-2xl pointer-events-none"
                  />
                )}

                <div
                  className={cn(
                    "relative flex flex-1 flex-col rounded-3xl p-6 md:p-7",
                    isPro
                      ? "border-2 border-nq-primary/60 bg-gradient-to-b from-nq-surface/70 to-nq-bg/40 shadow-[0_30px_80px_-30px_rgba(212,175,55,0.35)]"
                      : "border border-nq-border/30 bg-nq-surface/50",
                  )}
                >
                  {/* Badge row — always present to keep price vertically aligned */}
                  {plan.badge ? (
                    <span className="inline-flex w-fit items-center rounded-full border border-nq-primary/40 bg-nq-primary/15 px-3 py-1 text-[10px] font-bold tracking-[0.18em] text-nq-primary uppercase">
                      {plan.badge}
                    </span>
                  ) : (
                    <div className="h-[26px]" aria-hidden />
                  )}

                  {/* Plan name */}
                  <p className="mt-4 text-xs font-semibold uppercase tracking-widest text-nq-muted">
                    {plan.name}
                  </p>

                  {/* Price */}
                  <div className="mt-1 flex items-baseline gap-1">
                    <span
                      className={cn(
                        "font-bold tracking-tight text-nq-foreground",
                        isPro ? "text-5xl md:text-6xl" : "text-4xl md:text-5xl",
                      )}
                    >
                      {plan.price}
                    </span>
                    <span className="text-base text-nq-muted">{t.perMonth}</span>
                  </div>
                  <p className="mt-1 text-xs text-nq-muted/60">{t.taxNote}</p>

                  {/* Feature list — grows to fill remaining card height */}
                  <ul className="mt-6 flex-1 space-y-2.5">
                    {plan.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-2.5 text-sm text-nq-foreground"
                      >
                        <CheckIcon muted={!isPro} />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>

                  {/* CTA — pinned to card bottom.
                      Pro: filled gold, → /register.
                      Enterprise: outlined, → /contact (no checkout flow).
                      Free / Studio: outlined, → /register. */}
                  <div className="mt-7">
                    {isPro ? (
                      <Link
                        href="/register"
                        data-testid={`pricing-cta-${plan.id}`}
                        className="inline-flex w-full items-center justify-center rounded-full border border-nq-primary/50 bg-nq-primary px-6 py-3.5 text-sm font-semibold text-nq-bg shadow-[0_8px_28px_-8px_rgba(212,175,55,0.55)] transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
                      >
                        {plan.cta}
                      </Link>
                    ) : isEnterprise ? (
                      <Link
                        href="/contact"
                        data-testid={`pricing-cta-${plan.id}`}
                        className="inline-flex w-full items-center justify-center rounded-full border border-nq-border/50 bg-nq-surface/60 px-6 py-3 text-sm font-semibold text-nq-foreground transition hover:bg-nq-surface hover:border-nq-border/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
                      >
                        {plan.cta}
                      </Link>
                    ) : (
                      <Link
                        href="/register"
                        data-testid={`pricing-cta-${plan.id}`}
                        className="inline-flex w-full items-center justify-center rounded-full border border-nq-border/50 bg-nq-surface/60 px-6 py-3 text-sm font-semibold text-nq-foreground transition hover:bg-nq-surface hover:border-nq-border/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
                      >
                        {plan.cta}
                      </Link>
                    )}

                    {isPro && (
                      <>
                        <p className="mt-2.5 text-center text-xs text-nq-muted">
                          {t.ccNotice}
                        </p>
                        <p className="mt-1.5 text-center text-xs leading-snug text-nq-primary-soft/85">
                          {t.proMigrationNote}
                        </p>
                      </>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Add-ons rail (Task #10) — three small cards rendered below
            the four plans. Kept inside the same <section> so the
            visual rhythm follows the primary pricing block. */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 24 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="mt-14 md:mt-20"
        >
          <h3 className="text-center text-xl font-semibold tracking-tight text-nq-foreground md:text-2xl">
            {t.addons.sectionTitle}
          </h3>
          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-5">
            {([t.addons.sms, t.addons.location, t.addons.branding] as const).map(
              (addon) => (
                <div
                  key={addon.name}
                  className="flex flex-col rounded-2xl border border-nq-border/30 bg-nq-surface/40 p-5 md:p-6"
                >
                  <p className="text-xs font-semibold uppercase tracking-widest text-nq-muted">
                    {addon.name}
                  </p>
                  <p className="mt-2 text-lg font-semibold text-nq-foreground md:text-xl">
                    {addon.price}
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-nq-muted/80">
                    {addon.description}
                  </p>
                </div>
              ),
            )}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
