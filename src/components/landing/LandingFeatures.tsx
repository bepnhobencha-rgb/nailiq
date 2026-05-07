"use client";

import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import type { ReactNode } from "react";

type Feature = {
  icon: ReactNode;
  illustration: ReactNode;
  title: string;
  body: string;
};

const features: Feature[] = [
  {
    icon: <IconCalendar />,
    illustration: <PhoneCalendarIllustration />,
    title: "Online Booking",
    body:
      "Your booking link, open 24/7. Clients pick service, staff, and time without calling — works on any phone, no app install.",
  },
  {
    icon: <IconPolish />,
    illustration: <QueuePillsIllustration />,
    title: "Walk-in Queue",
    body:
      "Real-time queue management. No chaos during busy hours — see who's next at a glance, and customers always know their wait.",
  },
  {
    icon: <IconGrid />,
    illustration: <GridIllustration />,
    title: "Receptionist Center",
    body:
      "Live grid showing all bookings and walk-ins. Reschedule, reassign staff, and resolve conflicts in seconds, not minutes.",
  },
];

export function LandingFeatures() {
  const reduce = useReducedMotion();

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
            Features
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-nq-foreground md:text-5xl lg:text-6xl">
            Everything a nail salon needs
          </h2>
        </motion.div>

        <div className="mt-12 grid gap-6 md:grid-cols-3 md:gap-7">
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
              className="nq-feature-card group relative p-6 md:p-7"
            >
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-nq-primary/30 bg-nq-primary/10 text-nq-primary">
                {f.icon}
              </div>
              <div className="mt-6 h-20">{f.illustration}</div>
              <h3 className="mt-5 text-xl font-semibold text-nq-foreground">
                {f.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-nq-muted/75">
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

/** Tiny phone with calendar dots — Online Booking. */
function PhoneCalendarIllustration() {
  return (
    <div aria-hidden className="flex h-full items-end gap-3">
      <div className="relative h-20 w-12 rounded-[10px] border border-nq-primary/30 bg-nq-bg/60 p-1.5 shadow-[0_8px_24px_-12px_rgba(212,175,55,0.35)]">
        <div className="mx-auto h-1 w-3 rounded-full bg-nq-border/60" />
        <div className="mt-1.5 grid grid-cols-4 gap-[3px]">
          {Array.from({ length: 16 }).map((_, i) => (
            <span
              key={i}
              className={
                [3, 6, 9, 12].includes(i)
                  ? "h-1.5 w-full rounded-[2px] bg-nq-primary/80"
                  : "h-1.5 w-full rounded-[2px] bg-nq-border/40"
              }
            />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5 text-[10px] font-medium text-nq-muted">
        <span className="rounded-md border border-nq-primary/30 bg-nq-primary/10 px-2 py-0.5 text-nq-primary-soft">
          10:00
        </span>
        <span className="rounded-md border border-nq-primary/30 bg-nq-primary/10 px-2 py-0.5 text-nq-primary-soft">
          11:30
        </span>
        <span className="rounded-md border border-nq-border/40 bg-nq-surface/40 px-2 py-0.5">
          14:00
        </span>
      </div>
    </div>
  );
}

/** Three stacked queue pills — Walk-in Queue. */
function QueuePillsIllustration() {
  const rows = [
    { name: "Lan", svc: "Gel mani", tone: "primary" as const },
    { name: "Tina", svc: "Pedi", tone: "primary" as const },
    { name: "Walk-in", svc: "Quick mani", tone: "success" as const },
  ];
  return (
    <div aria-hidden className="flex h-full flex-col justify-end gap-1.5">
      {rows.map((r, i) => (
        <div
          key={i}
          className={
            r.tone === "success"
              ? "flex items-center justify-between rounded-md border border-nq-success/40 bg-nq-success/10 px-2 py-1.5 text-[11px]"
              : "flex items-center justify-between rounded-md border border-nq-primary/30 bg-nq-primary/10 px-2 py-1.5 text-[11px]"
          }
        >
          <span
            className={
              r.tone === "success"
                ? "font-semibold text-nq-success"
                : "font-semibold text-nq-primary-soft"
            }
          >
            {r.name}
          </span>
          <span className="text-nq-muted">{r.svc}</span>
        </div>
      ))}
    </div>
  );
}

/** Tiny 3-column grid — Receptionist Center. */
function GridIllustration() {
  const cells = [
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 0],
  ];
  return (
    <div aria-hidden className="flex h-full items-end">
      <div className="grid grid-cols-3 gap-1">
        {cells.flatMap((row, ri) =>
          row.map((c, ci) => (
            <span
              key={`${ri}-${ci}`}
              className={
                c
                  ? "h-5 w-12 rounded-[3px] border border-nq-primary/40 bg-nq-primary/15"
                  : "h-5 w-12 rounded-[3px] border border-nq-border/30 bg-nq-surface/30"
              }
            />
          )),
        )}
      </div>
    </div>
  );
}
