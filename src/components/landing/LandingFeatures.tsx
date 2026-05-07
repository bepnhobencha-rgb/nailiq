"use client";

import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import type { ReactNode } from "react";

type Feature = {
  icon: ReactNode;
  title: string;
  body: string;
};

const features: Feature[] = [
  {
    icon: <IconCalendar />,
    title: "Online Booking",
    body:
      "Your booking link, open 24/7. Clients pick service, staff, and time without calling — works on any phone, no app install.",
  },
  {
    icon: <IconPolish />,
    title: "Walk-in Queue",
    body:
      "Real-time queue management. No chaos during busy hours — see who's next at a glance, and customers always know their wait.",
  },
  {
    icon: <IconGrid />,
    title: "Receptionist Center",
    body:
      "Live grid showing all bookings and walk-ins. Reschedule, reassign staff, and resolve conflicts in seconds, not minutes.",
  },
];

export function LandingFeatures() {
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
            Everything You Need
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-nq-foreground md:text-4xl lg:text-5xl">
            Everything a nail salon needs
          </h2>
        </motion.div>

        <div className="mt-12 grid gap-8 md:grid-cols-3 md:gap-10">
          {features.map((f, i) => (
            <motion.div
              key={f.title}
              initial={reduce ? false : { opacity: 0, y: 24 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{
                duration: 0.55,
                delay: i * 0.08,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="group"
            >
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-nq-primary/30 bg-nq-primary/10 text-nq-primary">
                {f.icon}
              </div>
              <h3 className="mt-5 text-xl font-semibold text-nq-foreground">
                {f.title}
              </h3>
              <p className="mt-3 text-base leading-relaxed text-nq-muted">
                {f.body}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function IconCalendar() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-6 w-6"
    >
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 10h18" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
      <path d="M8 14h3" />
      <path d="M13 17h3" />
    </svg>
  );
}

function IconPolish() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-6 w-6"
    >
      <path d="M9 8h6l-1 4H10z" />
      <path d="M10 12v9h4v-9" />
      <path d="M11 4h2v4h-2z" />
      <path d="M7 21h10" />
    </svg>
  );
}

function IconGrid() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-6 w-6"
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
