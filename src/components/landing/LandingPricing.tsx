"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";

const features = [
  "All features included",
  "Unlimited bookings & walk-ins",
  "Vietnamese & English support",
  "Real-time receptionist center",
  "Cancel anytime — no contract",
];

export function LandingPricing() {
  const reduce = useReducedMotion();

  return (
    <section className="relative bg-nq-bg py-20 md:py-32">
      <div className="mx-auto w-full max-w-3xl px-5 md:px-8">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="text-center"
        >
          <p className="text-xs font-semibold tracking-[0.2em] text-nq-primary uppercase">
            Pricing
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-nq-foreground md:text-4xl">
            One simple plan
          </h2>
          <p className="mt-3 text-base text-nq-muted md:text-lg">
            No hidden fees. Cancel anytime.
          </p>
        </motion.div>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 24 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.65, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
          className="relative mx-auto mt-12 max-w-md"
        >
          <div
            aria-hidden
            className="absolute -inset-3 rounded-[28px] bg-gradient-to-br from-nq-primary/20 via-transparent to-nq-primary/10 blur-2xl"
          />
          <div className="relative rounded-3xl border-2 border-nq-primary/60 bg-gradient-to-b from-nq-surface/70 to-nq-bg/40 p-8 shadow-[0_30px_80px_-30px_rgba(212,175,55,0.4)] md:p-10">
            <span className="inline-flex items-center rounded-full border border-nq-primary/40 bg-nq-primary/15 px-3 py-1 text-[10px] font-bold tracking-[0.18em] text-nq-primary uppercase">
              Most Popular
            </span>

            <div className="mt-6 flex items-baseline gap-1">
              <span className="text-6xl font-bold tracking-tight text-nq-foreground md:text-7xl">
                $29
              </span>
              <span className="text-lg text-nq-muted">/month</span>
            </div>
            <p className="mt-2 text-xs text-nq-muted">
              + applicable taxes. CAD pricing.
            </p>

            <ul className="mt-8 space-y-3">
              {features.map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-3 text-sm text-nq-foreground md:text-base"
                >
                  <span
                    aria-hidden
                    className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-nq-primary/20 text-nq-primary"
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
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            <Link
              href="/register"
              className="mt-8 inline-flex w-full items-center justify-center rounded-full border border-nq-primary/50 bg-nq-primary px-6 py-3.5 text-base font-semibold text-nq-bg shadow-[0_8px_28px_-8px_rgba(212,175,55,0.55)] transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
            >
              Start your 14-day free trial
            </Link>
            <p className="mt-3 text-center text-xs text-nq-muted">
              No credit card required
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
