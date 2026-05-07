"use client";

import { motion, useReducedMotion } from "@/shared/lib/motionClient";

type Stat = {
  number: string;
  sub: string;
  label: string;
  body: string;
};

const stats: Stat[] = [
  {
    number: "$50–200",
    sub: "/day",
    label: "Lost from missed calls",
    body: "Phones ring while staff are busy. Each unanswered call is a booking that walks down the block to your competitor.",
  },
  {
    number: "23%",
    sub: "of clients",
    label: "Don't rebook after first visit",
    body: "Without an easy booking link, returning customers default to whoever has online slots — even if they loved you.",
  },
  {
    number: "Walk-ins",
    sub: "leave",
    label: "When you're too busy to take them",
    body: "No queue means walk-ins guess at wait times, get frustrated, and leave. A live queue keeps them — and your revenue.",
  },
];

export function LandingPainSection() {
  const reduce = useReducedMotion();

  return (
    <section className="relative bg-nq-bg py-20 md:py-32">
      <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="text-xs font-semibold tracking-[0.2em] text-nq-primary uppercase">
            The Problem
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-nq-foreground md:text-4xl lg:text-5xl">
            You&rsquo;re losing money right now
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-nq-muted">
            Every salon owner we&rsquo;ve talked to has the same three holes in
            the bucket. Here&rsquo;s the math.
          </p>
        </motion.div>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {stats.map((s, i) => (
            <motion.div
              key={s.label}
              initial={reduce ? false : { opacity: 0, y: 24 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{
                duration: 0.55,
                delay: i * 0.08,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="group rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-6 transition-transform hover:-translate-y-0.5 md:p-7"
            >
              <div className="flex items-baseline gap-1">
                <span className="text-5xl font-bold tracking-tight text-nq-primary md:text-6xl">
                  {s.number}
                </span>
                <span className="text-sm font-medium text-nq-muted">
                  {s.sub}
                </span>
              </div>
              <p className="mt-4 text-base font-semibold text-nq-foreground">
                {s.label}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-nq-muted">
                {s.body}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
