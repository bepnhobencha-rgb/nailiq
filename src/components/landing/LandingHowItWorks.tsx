"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";

type Step = {
  number: string;
  title: string;
  body: string;
};

const steps: Step[] = [
  {
    number: "01",
    title: "Sign up with your phone",
    body: "OTP verification. No email required to start.",
  },
  {
    number: "02",
    title: "Add services and staff",
    body: "Pre-loaded templates speed it up. Most salons finish in 10 minutes.",
  },
  {
    number: "03",
    title: "Share your booking link",
    body: "Copy your nailiq.com/your-salon URL. Send to clients via Zalo, SMS, or stick on the front desk.",
  },
];

export function LandingHowItWorks() {
  const reduce = useReducedMotion();

  return (
    <section
      id="how-it-works"
      className="relative scroll-mt-24 bg-nq-bg py-20 md:py-32"
    >
      <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="text-xs font-semibold tracking-[0.2em] text-nq-primary uppercase">
            Get Started
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-nq-foreground md:text-4xl lg:text-5xl">
            Live in 15 minutes
          </h2>
        </motion.div>

        <div className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
          {steps.map((s, i) => (
            <motion.div
              key={s.number}
              initial={reduce ? false : { opacity: 0, y: 24 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{
                duration: 0.55,
                delay: i * 0.1,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="relative"
            >
              <div className="text-6xl font-bold leading-none tracking-tight text-nq-primary/30 md:text-7xl">
                {s.number}
              </div>
              <h3 className="mt-4 text-xl font-semibold text-nq-foreground">
                {s.title}
              </h3>
              <p className="mt-3 text-base leading-relaxed text-nq-muted">
                {s.body}
              </p>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={reduce ? false : { opacity: 0 }}
          whileInView={reduce ? undefined : { opacity: 1 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mt-12 flex items-center justify-center"
        >
          <Link
            href="/register"
            className="group inline-flex items-center gap-2 text-sm font-medium text-nq-primary-soft transition hover:text-nq-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg rounded-md px-2 py-1"
          >
            Ready when you are. Try free for 14 days
            <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
