"use client";

/**
 * ReceptionistMockup — decorative hero illustration.
 *
 * Shows a mini receptionist dashboard. Automatically cycles between
 * English and Vietnamese copy every 3.5 s so visitors see the product
 * supports both locales. Language-variant sections (date header, KPI
 * chips, queue label) animate with a vertical slide-fade via
 * AnimatePresence; the booking grid and static chrome stay fixed.
 *
 * Purely decorative — aria-hidden, no interactions.
 */

import { useEffect, useState } from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "@/shared/lib/motionClient";
import { cn } from "@/shared/lib/cn";

// ─── Static data ─────────────────────────────────────────────────────────────

const STAFF = ["Linh", "Mai", "Hoa"] as const;

const SLOTS = [
  "9:00",
  "9:30",
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "12:00",
] as const;

const ROW_H = 32; // px per 30-min slot

/** "Now" line: 2.4 slots from top (between 10:00 and 10:30) */
const NOW_OFFSET = 2.4;

/** How long each locale displays before flipping (ms) */
const CYCLE_MS = 3500;

type Status = "confirmed" | "pending" | "in_progress";

const STATUS_CLS: Record<Status, string> = {
  confirmed: "bg-nq-info/85 text-white",
  pending: "bg-nq-warning/15 text-nq-foreground border border-nq-warning/45",
  in_progress: "bg-nq-success/85 text-white",
};

interface MockBooking {
  id: string;
  row: number;
  span: number;
  col: number;
  client: string;
  service: string;
  status: Status;
  heart?: boolean;
}

const BOOKINGS: MockBooking[] = [
  {
    id: "b1",
    row: 1,
    span: 2,
    col: 0,
    client: "Ngọc A.",
    service: "Gel Mani",
    status: "confirmed",
    heart: true,
  },
  {
    id: "b2",
    row: 0,
    span: 2,
    col: 1,
    client: "Hương T.",
    service: "Nail Art",
    status: "in_progress",
  },
  {
    id: "b3",
    row: 3,
    span: 2,
    col: 1,
    client: "Phương N.",
    service: "Pedicure",
    status: "pending",
  },
  {
    id: "b4",
    row: 4,
    span: 2,
    col: 2,
    client: "Thu H.",
    service: "Pedicure",
    status: "confirmed",
  },
  {
    id: "b5",
    row: 5,
    span: 2,
    col: 0,
    client: "Lan V.",
    service: "Acrylic",
    status: "pending",
  },
];

// ─── Bilingual copy ───────────────────────────────────────────────────────────

type Lang = "vi" | "en";

interface LocaleCopy {
  date: string;
  today: string;
  booked: string;
  waiting: string;
  queueLabel: string;
  waitSuffix: string;
}

const COPY: Record<Lang, LocaleCopy> = {
  vi: {
    date: "Thứ Hai, 11/05",
    today: "Hôm nay",
    booked: "5 lịch",
    waiting: "2 chờ",
    queueLabel: "Hàng chờ",
    waitSuffix: "phút",
  },
  en: {
    date: "Monday, 05/11",
    today: "Today",
    booked: "5 booked",
    waiting: "2 waiting",
    queueLabel: "Queue",
    waitSuffix: "min",
  },
};

const QUEUE_ENTRIES = [
  { id: "q1", pos: 1, name: "Bảo M.", service: "Gel Mani", waitMin: 5 },
  { id: "q2", pos: 2, name: "Tuyết N.", service: "Pedicure", waitMin: 14 },
];

// ─── Component ───────────────────────────────────────────────────────────────

interface ReceptionistMockupProps {
  reduce?: boolean;
}

export function ReceptionistMockup({ reduce }: ReceptionistMockupProps) {
  const prefersReduced = useReducedMotion();
  const noMotion = reduce ?? prefersReduced ?? false;

  const [lang, setLang] = useState<Lang>("vi");

  // Cycle between VI and EN, pause when reduced-motion is preferred
  useEffect(() => {
    if (noMotion) return;
    const id = setInterval(() => {
      setLang((l) => (l === "vi" ? "en" : "vi"));
    }, CYCLE_MS);
    return () => clearInterval(id);
  }, [noMotion]);

  const copy = COPY[lang];
  const totalHeight = SLOTS.length * ROW_H;

  return (
    <div aria-hidden="true" className="relative w-full select-none">
      {/* Ambient glow */}
      <div className="pointer-events-none absolute -inset-10 rounded-[36px] bg-[radial-gradient(closest-side,rgba(212,175,55,0.22),rgba(212,175,55,0.06)_55%,transparent_80%)] blur-2xl" />
      <div className="pointer-events-none absolute -inset-2 rounded-[28px] bg-gradient-to-br from-nq-primary/12 via-transparent to-transparent blur-xl" />

      {/* Dashboard shell */}
      <div
        className={cn(
          "relative overflow-hidden rounded-2xl border border-nq-border/40 bg-nq-surface/60 backdrop-blur-md",
          "shadow-[0_40px_100px_-30px_rgba(0,0,0,0.75),0_8px_28px_-8px_rgba(212,175,55,0.18),0_0_0_1px_rgba(212,175,55,0.14)]",
          !noMotion && "nq-mockup-float",
        )}
      >
        {/* ── Chrome bar ── */}
        <div className="flex items-center gap-2 border-b border-nq-border/30 px-3 py-2.5">
          <span className="h-2 w-2 rounded-full bg-red-400/70" />
          <span className="h-2 w-2 rounded-full bg-yellow-400/70" />
          <span className="h-2 w-2 rounded-full bg-green-400/70" />
          <div className="ml-2 flex-1 truncate rounded border border-nq-border/30 bg-nq-bg/50 px-2 py-0.5 text-[9px] text-nq-muted">
            nailiq.ca/dashboard/blossom-nail/center
          </div>

          {/* Language badge — cycles with the copy */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={`lang-${lang}`}
              initial={{ opacity: 0, scale: 0.75 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.75 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="shrink-0 rounded border border-nq-border/40 px-1.5 py-0.5 text-[8px] font-bold tracking-widest text-nq-muted"
            >
              {lang.toUpperCase()}
            </motion.span>
          </AnimatePresence>

          {/* Realtime LIVE dot */}
          <div className="flex shrink-0 items-center gap-1">
            <span className="relative flex h-1.5 w-1.5">
              {!noMotion && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-nq-success opacity-75" />
              )}
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-nq-success" />
            </span>
            <span className="text-[8px] font-semibold uppercase tracking-widest text-nq-success">
              Live
            </span>
          </div>
        </div>

        {/* ── Date sub-header (language-variant) ── */}
        <div className="relative border-b border-nq-border/20 px-3 py-1.5">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`header-${lang}`}
              className="flex items-center gap-2"
              initial={{ opacity: 0, y: -5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 5 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <span className="text-[9px] font-medium text-nq-foreground/70">
                {copy.date}
              </span>
              <span className="rounded-full bg-nq-primary/15 px-1.5 py-0.5 text-[8px] font-semibold text-nq-primary">
                {copy.today}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <span className="rounded-full bg-nq-info/15 px-1.5 py-0.5 font-mono text-[8px] tabular-nums text-nq-info">
                  {copy.booked}
                </span>
                <span className="rounded-full bg-nq-warning/15 px-1.5 py-0.5 font-mono text-[8px] tabular-nums text-nq-warning">
                  {copy.waiting}
                </span>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* ── Main body: timeline grid + queue panel ── */}
        <div className="flex">
          {/* ── Timeline grid (static — client names & services unchanged) ── */}
          <div className="min-w-0 flex-1 p-2.5">
            {/* Staff column headers */}
            <div
              className="mb-1 grid gap-x-1.5"
              style={{ gridTemplateColumns: "28px repeat(3, minmax(0, 1fr))" }}
            >
              <div />
              {STAFF.map((name) => (
                <div
                  key={name}
                  className="rounded bg-nq-bg/50 py-1 text-center text-[9px] font-semibold tracking-wide text-nq-foreground/75"
                >
                  {name}
                </div>
              ))}
            </div>

            {/* Grid body */}
            <div className="relative" style={{ height: totalHeight }}>
              {/* Time labels */}
              {SLOTS.map((slot, i) => (
                <div
                  key={slot}
                  className="absolute text-right font-mono text-[8px] tabular-nums text-nq-muted/60"
                  style={{ top: i * ROW_H + 4, right: "calc(100% - 26px)" }}
                >
                  {slot}
                </div>
              ))}

              {/* Booking cells grid */}
              <div
                className="absolute inset-y-0 right-0 grid gap-x-1.5"
                style={{
                  left: 32,
                  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                  gridTemplateRows: `repeat(${SLOTS.length}, ${ROW_H}px)`,
                }}
              >
                {/* Grid line cells */}
                {SLOTS.flatMap((_, ri) =>
                  [0, 1, 2].map((ci) => (
                    <div
                      key={`cell-${ri}-${ci}`}
                      className="border-t border-nq-border/15"
                      style={{ gridColumn: ci + 1, gridRow: ri + 1 }}
                    />
                  )),
                )}

                {/* Booking blocks — staggered entrance */}
                {BOOKINGS.map((b, idx) => (
                  <motion.div
                    key={b.id}
                    initial={noMotion ? false : { opacity: 0, y: 8, scale: 0.94 }}
                    animate={noMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
                    transition={{
                      duration: 0.45,
                      delay: 0.3 + idx * 0.1,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                    className={cn(
                      "overflow-hidden rounded-md px-1.5 py-1 text-[8.5px] leading-tight",
                      STATUS_CLS[b.status],
                    )}
                    style={{
                      gridColumn: b.col + 1,
                      gridRow: `${b.row + 1} / span ${b.span}`,
                      zIndex: 2,
                      margin: "2px 1px",
                    }}
                  >
                    <div className="flex items-start gap-0.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{b.client}</p>
                        <p className="truncate opacity-75">{b.service}</p>
                      </div>
                      {b.heart === true && (
                        <span className="shrink-0 text-[9px] leading-none">
                          ❤️
                        </span>
                      )}
                    </div>
                  </motion.div>
                ))}
              </div>

              {/* Now gold line */}
              <div
                className="pointer-events-none absolute right-0 z-10 flex items-center gap-1.5"
                style={{ top: NOW_OFFSET * ROW_H, left: 28 }}
              >
                <span className="relative flex h-2 w-2 shrink-0">
                  {!noMotion && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-nq-primary opacity-60" />
                  )}
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-nq-primary" />
                </span>
                <span className="block h-px flex-1 bg-gradient-to-r from-nq-primary/80 via-nq-primary/40 to-transparent" />
              </div>
            </div>
          </div>

          {/* ── Queue panel (hidden < sm) ── */}
          <div className="hidden w-[110px] shrink-0 border-l border-nq-border/20 p-2 sm:block">
            {/* Queue label — language-variant */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={`queue-label-${lang}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="mb-2 text-[8px] font-semibold uppercase tracking-wider text-nq-muted"
              >
                {copy.queueLabel}
              </motion.p>
            </AnimatePresence>

            {QUEUE_ENTRIES.map((q, qi) => (
              <motion.div
                key={q.id}
                initial={noMotion ? false : { opacity: 0, x: 10 }}
                animate={noMotion ? undefined : { opacity: 1, x: 0 }}
                transition={{
                  duration: 0.4,
                  delay: 0.65 + qi * 0.12,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className="mb-1.5 rounded-lg border border-nq-border/30 bg-nq-bg/50 p-1.5"
              >
                <div className="flex items-center gap-1">
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-nq-surface text-[7px] font-bold tabular-nums text-nq-muted ring-1 ring-inset ring-nq-border">
                    {q.pos}
                  </span>
                  <span className="truncate text-[8.5px] font-semibold text-nq-foreground">
                    {q.name}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[7.5px] text-nq-muted">
                  {q.service}
                </p>

                {/* Wait time — suffix also language-variant */}
                <p
                  className={cn(
                    "mt-1 font-mono text-[11px] font-bold tabular-nums",
                    q.waitMin >= 10 ? "text-nq-warning" : "text-nq-muted",
                  )}
                >
                  {q.waitMin}{" "}
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={`wait-suffix-${lang}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="text-[8px] font-normal"
                    >
                      {copy.waitSuffix}
                    </motion.span>
                  </AnimatePresence>
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
