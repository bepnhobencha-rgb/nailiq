"use client";

import { AnimatePresence, motion } from "@/shared/lib/motionClient";
import { useCallback, useState } from "react";
import { IphoneHomeIndicator } from "@/components/ui/phone/IphoneHomeIndicator";
import type { PhoneBookingCopy } from "@/components/ui/phone/phoneFrameTypes";
import { cn } from "@/shared/lib/cn";

const DAYS = ["M", "T", "W", "T", "F", "S", "S"] as const;

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

const stepVariants = {
  enter: (dir: number) => ({
    x: dir * 20,
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
  },
  exit: (dir: number) => ({
    x: dir * -20,
    opacity: 0,
  }),
};

type PhoneBookingViewProps = {
  copy: PhoneBookingCopy;
  services: readonly [string, string, string];
  times: readonly [string, string, string];
  reduced: boolean;
};

/**
 * 3-step booking demo (service → time → done) for the marketing iPhone. GPU-friendly
 * slide transitions; `prefers-reduced-motion` flattens motion.
 */
export function PhoneBookingView({
  copy,
  services,
  times,
  reduced,
}: PhoneBookingViewProps) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [serviceIdx, setServiceIdx] = useState(0);
  const [dayIdx, setDayIdx] = useState(3);
  const [timeIdx, setTimeIdx] = useState(1);

  const goStep = useCallback(
    (next: number) => {
      if (reduced) {
        setStep(next);
        return;
      }
      setDir(next > step ? 1 : -1);
      setStep(next);
    },
    [reduced, step],
  );

  const stepLabels = [copy.stepService, copy.stepTime, copy.stepComplete] as const;
  const tap = reduced ? undefined : { scale: 0.97 };
  const transition = reduced
    ? { duration: 0 }
    : { duration: 0.3, ease: EASE };

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-2xl",
        "bg-nq-bg ring-1 ring-inset ring-nq-primary/12",
      )}
    >
      <header className="shrink-0 border-b border-nq-border/25 px-2 pt-0.5 pb-1.5">
        <p className="text-center text-[10px] font-semibold tracking-wide text-nq-foreground/95">
          {copy.appBarTitle}
        </p>
        <ol
          className="mt-1.5 flex items-center justify-center gap-0.5"
          aria-label={copy.appBarTitle}
        >
          {stepLabels.map((label, i) => {
            const active = i === step;
            const done = i < step;
            return (
              <li key={i} className="flex min-w-0 items-center">
                {i > 0 ? (
                  <span
                    className="mx-0.5 h-px w-2 bg-nq-border/50"
                    aria-hidden
                  />
                ) : null}
                <span
                  className={cn(
                    "max-w-[4.2rem] truncate text-[7px] font-medium uppercase tracking-wider",
                    done && "text-nq-primary/90",
                    active && "text-nq-primary",
                    !active && !done && "text-nq-muted/55",
                  )}
                >
                  {label}
                </span>
              </li>
            );
          })}
        </ol>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AnimatePresence custom={dir} mode="wait" initial={false}>
          <motion.div
            key={step}
            custom={dir}
            variants={stepVariants}
            initial={reduced ? false : "enter"}
            animate="center"
            exit={reduced ? undefined : "exit"}
            transition={transition}
            className="absolute inset-0 flex min-h-0 flex-col overflow-y-auto overflow-x-hidden px-2.5 py-1.5"
            style={reduced ? undefined : { willChange: "transform, opacity" }}
          >
            {step === 0 ? (
              <ServiceStep
                services={services}
                selected={serviceIdx}
                onSelect={setServiceIdx}
                reduced={reduced}
                tap={tap}
              />
            ) : null}
            {step === 1 ? (
              <TimeStep
                dayIdx={dayIdx}
                onDay={setDayIdx}
                timeIdx={timeIdx}
                onTime={setTimeIdx}
                times={times}
                dateLine={copy.dateLine}
                reduced={reduced}
                tap={tap}
              />
            ) : null}
            {step === 2 ? (
              <DoneStep
                service={services[serviceIdx]}
                time={times[timeIdx]}
                title={copy.doneTitle}
                subtitle={copy.doneSubtitle}
                onBookAnother={() => {
                  if (!reduced) {
                    setDir(1);
                  }
                  setStep(0);
                }}
                bookAnotherLabel={copy.bookAnother}
                doneMotion={!reduced}
                tap={tap}
              />
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>

      <footer className="shrink-0 border-t border-nq-border/20 px-2 pt-1 pb-0.5">
        {step < 2 ? (
          <div className="flex items-center justify-between gap-1.5">
            <motion.button
              type="button"
              tabIndex={-1}
              disabled={step === 0}
              onClick={() => step > 0 && goStep(step - 1)}
              className={cn(
                "rounded-lg px-2 py-1.5 text-[8px] font-medium tracking-wide",
                step === 0
                  ? "text-nq-muted/30"
                  : "text-nq-muted/85 active:text-nq-foreground/90",
              )}
              whileTap={step === 0 || !tap ? undefined : tap}
            >
              {copy.back}
            </motion.button>
            <motion.button
              type="button"
              tabIndex={-1}
              onClick={() => goStep(step + 1)}
              className="rounded-lg bg-nq-primary px-3 py-1.5 text-[8px] font-semibold text-nq-bg shadow-sm ring-1 ring-nq-primary/30"
              whileTap={tap}
            >
              {copy.continue}
            </motion.button>
          </div>
        ) : null}
        <IphoneHomeIndicator className="pb-0" />
      </footer>
    </div>
  );
}

type Tap = { scale: number } | undefined;

function ServiceStep({
  services,
  selected,
  onSelect,
  reduced,
  tap,
}: {
  services: readonly [string, string, string];
  selected: number;
  onSelect: (i: number) => void;
  reduced: boolean;
  tap: Tap;
}) {
  return (
    <ul className="mt-0.5 flex min-h-0 flex-col gap-1" role="list">
      {services.map((name, i) => {
        const on = i === selected;
        return (
          <li key={i}>
            <motion.button
              type="button"
              tabIndex={-1}
              onClick={() => onSelect(i)}
              className={cn(
                "flex w-full items-center justify-between rounded-xl border px-2 py-1.5 text-left text-[9px] font-medium",
                on
                  ? "border-nq-primary/40 bg-nq-surface/80 text-nq-foreground ring-1 ring-nq-primary/25"
                  : "border-nq-border/30 bg-nq-surface/30 text-nq-foreground/90",
              )}
              whileTap={tap}
              initial={false}
              animate={reduced ? false : { scale: on ? 1.01 : 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.4 }}
            >
              <span className="min-w-0 truncate">{name}</span>
              {on ? (
                <span className="shrink-0 text-[7px] font-semibold text-nq-primary">
                  ✓
                </span>
              ) : null}
            </motion.button>
          </li>
        );
      })}
    </ul>
  );
}

function TimeStep({
  dayIdx,
  onDay,
  timeIdx,
  onTime,
  times,
  dateLine,
  reduced,
  tap,
}: {
  dayIdx: number;
  onDay: (i: number) => void;
  timeIdx: number;
  onTime: (i: number) => void;
  times: readonly [string, string, string];
  dateLine: string;
  reduced: boolean;
  tap: Tap;
}) {
  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      <p className="text-center text-[8px] font-medium text-nq-muted/80">
        {dateLine}
      </p>
      <div className="flex justify-center gap-1" aria-hidden>
        {DAYS.map((d, i) => {
          const on = i === dayIdx;
          return (
            <motion.button
              key={`${d}-${i}`}
              type="button"
              tabIndex={-1}
              onClick={() => onDay(i)}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-lg text-[8px] font-medium",
                on
                  ? "bg-nq-primary/12 text-nq-primary ring-1 ring-nq-primary/35"
                  : "bg-nq-surface/45 text-nq-muted/65",
              )}
              whileTap={tap}
              initial={false}
              animate={reduced ? false : { scale: on ? 1.04 : 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 32 }}
            >
              {d}
            </motion.button>
          );
        })}
      </div>
      <div className="flex flex-wrap justify-center gap-1.5">
        {times.map((t, i) => {
          const on = i === timeIdx;
          return (
            <motion.button
              key={t}
              type="button"
              tabIndex={-1}
              onClick={() => onTime(i)}
              className={cn(
                "rounded-xl px-2.5 py-1.5 text-[9px] font-medium tabular-nums tracking-wide",
                on
                  ? "bg-nq-surface/95 text-nq-foreground shadow-nq-glow ring-1 ring-nq-primary/45"
                  : "bg-nq-surface/45 text-nq-muted/80 ring-1 ring-nq-border/35",
              )}
              whileTap={tap}
            >
              {t}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

function DoneStep({
  service,
  time,
  title,
  subtitle,
  onBookAnother,
  bookAnotherLabel,
  tap,
  doneMotion,
}: {
  service: string;
  time: string;
  title: string;
  subtitle: string;
  onBookAnother: () => void;
  bookAnotherLabel: string;
  tap: Tap;
  doneMotion: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-col items-center justify-center gap-1.5 text-center">
      <motion.div
        className="flex h-10 w-10 items-center justify-center rounded-full bg-nq-primary/12 ring-1 ring-nq-primary/30"
        initial={doneMotion ? { scale: 0.92, opacity: 0 } : false}
        animate={{ scale: 1, opacity: 1 }}
        transition={doneMotion ? { type: "spring", stiffness: 420, damping: 28 } : { duration: 0 }}
      >
        <svg
          className="h-5 w-5 text-nq-primary"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </motion.div>
      <p className="text-[10px] font-semibold text-nq-foreground/95">{title}</p>
      <p className="px-0.5 text-[8px] leading-relaxed text-nq-muted/85">{subtitle}</p>
      <p className="mt-0.5 text-[8px] text-nq-primary/90">
        {service}
        <span className="text-nq-muted/50"> · </span>
        {time}
      </p>
      <motion.button
        type="button"
        tabIndex={-1}
        onClick={onBookAnother}
        className="mt-1 rounded-lg border border-nq-primary/35 bg-nq-primary/8 px-2.5 py-1.5 text-[8px] font-medium text-nq-primary"
        whileTap={tap}
      >
        {bookAnotherLabel}
      </motion.button>
    </div>
  );
}
