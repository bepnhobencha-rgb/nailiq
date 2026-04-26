"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { cn } from "@/shared/lib/cn";

const SEQUENCE = [135, 180, 220] as const;
const INTERVAL_MS = 2000;

type MoneyLossCounterProps = {
  label: string;
  className?: string;
};

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const read = () => setReduced(mq.matches);
    read();
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, []);
  return reduced;
}

/**
 * Cycles $135 → $180 → $220 every 2s with a subtle number transition.
 */
export function MoneyLossCounter({ label, className }: MoneyLossCounterProps) {
  const reduced = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const amount = SEQUENCE[index % SEQUENCE.length]!;

  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % SEQUENCE.length);
    }, INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [reduced]);

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        className,
      )}
    >
      <div className="rounded-2xl border border-nq-border/30 bg-nq-surface/50 px-6 py-5 sm:px-8 sm:py-6">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-nq-muted/90 sm:text-sm">
          {label}
        </p>
        <p className="mt-2 min-h-[2.75rem] tabular-nums sm:min-h-[3.25rem]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={reduced ? "static" : amount}
              initial={{ opacity: 0.35, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0.25, y: -3 }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              className="inline-block text-3xl font-bold tracking-tight text-nq-foreground sm:text-4xl"
            >
              ${reduced ? SEQUENCE[SEQUENCE.length - 1] : amount}
            </motion.span>
          </AnimatePresence>
        </p>
      </div>
    </div>
  );
}
