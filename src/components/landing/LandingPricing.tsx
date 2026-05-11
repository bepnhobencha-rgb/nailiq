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
      <div className="mx-auto w-full max-w-5xl px-5 md:px-8">
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

        {/* Plans grid — stacked on mobile, 3-col on md+ */}
        <div className="mt-10 grid grid-cols-1 gap-5 md:grid-cols-3 md:items-stretch lg:gap-6">
          {t.plans.map((plan, i) => {
            const isPro = plan.id === "pro";
            const isStudio = plan.id === "studio";

            return (
              <motion.div
                key={plan.id}
                initial={reduce ? false : { opacity: 0, y: 24 }}
                whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{
                  duration: 0.55,
                  delay: 0.05 + i * 0.1,
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
                    "relative flex flex-1 flex-col rounded-3xl p-7 md:p-8",
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
                        isPro ? "text-6xl md:text-7xl" : "text-5xl md:text-6xl",
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

                  {/* CTA — pinned to card bottom */}
                  <div className="mt-7">
                    {isStudio ? (
                      <button
                        type="button"
                        disabled
                        className="inline-flex w-full cursor-not-allowed items-center justify-center rounded-full border border-nq-border/25 bg-nq-surface/30 px-6 py-3 text-sm font-semibold text-nq-muted/40"
                      >
                        {plan.cta}
                      </button>
                    ) : isPro ? (
                      <Link
                        href="/register"
                        className="inline-flex w-full items-center justify-center rounded-full border border-nq-primary/50 bg-nq-primary px-6 py-3.5 text-sm font-semibold text-nq-bg shadow-[0_8px_28px_-8px_rgba(212,175,55,0.55)] transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
                      >
                        {plan.cta}
                      </Link>
                    ) : (
                      <Link
                        href="/register"
                        className="inline-flex w-full items-center justify-center rounded-full border border-nq-border/50 bg-nq-surface/60 px-6 py-3 text-sm font-semibold text-nq-foreground transition hover:bg-nq-surface hover:border-nq-border/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
                      >
                        {plan.cta}
                      </Link>
                    )}

                    {isPro && (
                      <p className="mt-2.5 text-center text-xs text-nq-muted">
                        {t.ccNotice}
                      </p>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
