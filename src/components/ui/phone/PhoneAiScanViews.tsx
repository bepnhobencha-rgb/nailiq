"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useMemo, type ReactNode } from "react";
import type { PhoneAiDemoState } from "./phoneFrameTypes";

type PhoneAiIdleScanProps = {
  label: string;
  hint: string;
  reduced: boolean;
};

/**
 * “Menu scan” idle state: subtle frame + gold scan line.
 */
export function PhoneAiIdleScan({ label, hint, reduced }: PhoneAiIdleScanProps) {
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-nq-border/30 bg-nq-surface/25">
      <p className="z-10 px-2 pt-1.5 text-center text-[9px] font-medium tracking-wider text-nq-primary/85">
        {label}
      </p>
      <p className="z-10 px-2 pb-1 text-center text-[8px] text-nq-muted/75">{hint}</p>
      <div className="relative mx-1.5 mb-1.5 min-h-0 flex-1 overflow-hidden rounded-xl border border-nq-border/20 bg-nq-bg/50">
        <div className="absolute inset-0 flex items-center justify-center p-2">
          <p className="text-[10px] font-medium tracking-[0.2em] text-nq-muted/35">
            MENU
          </p>
        </div>
        {!reduced ? (
          <motion.div
            className="pointer-events-none absolute right-0 left-0 h-[2px] bg-gradient-to-r from-transparent via-nq-primary to-transparent"
            style={{ top: 0, boxShadow: "0 0 12px rgba(212, 175, 55, 0.45)" }}
            animate={{ top: ["12%", "88%", "12%"] }}
            transition={{
              duration: 2.4,
              repeat: Number.POSITIVE_INFINITY,
              ease: "easeInOut",
            }}
          />
        ) : null}
        <div
          className="pointer-events-none absolute inset-0 border border-nq-border/10"
          aria-hidden
        />
      </div>
    </div>
  );
}

type PhoneAiFileDemoProps = {
  demo: PhoneAiDemoState;
  /** Scan duration in seconds (1.5) */
  scanDuration: number;
  menuRows: ReadonlyArray<{ category: string; name: string; price: string }>;
  reduced: boolean;
};

function MenuListByCategory({
  menuRows,
}: {
  menuRows: ReadonlyArray<{ category: string; name: string; price: string }>;
}) {
  const byCat = useMemo(() => {
    const m = new Map<string, { category: string; name: string; price: string }[]>();
    for (const row of menuRows) {
      const prev = m.get(row.category) ?? [];
      m.set(row.category, [...prev, row]);
    }
    return m;
  }, [menuRows]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden rounded-2xl border border-nq-border/30 bg-nq-bg/60 p-1.5">
      <p className="mb-1 text-center text-[8px] font-medium uppercase tracking-wider text-nq-primary/80">
        Services
      </p>
      <ul className="min-h-0 space-y-2">
        {Array.from(byCat.entries()).map(([cat, rows]) => (
          <li key={cat}>
            <p className="mb-0.5 pl-0.5 text-[8px] font-semibold uppercase tracking-wide text-nq-primary/90">
              {cat}
            </p>
            <ul className="space-y-1">
              {rows.map((r) => (
                <li
                  key={`${r.name}-${r.price}`}
                  className="flex items-center justify-between gap-1 rounded-lg border border-nq-border/25 bg-nq-surface/50 px-1.5 py-1"
                >
                  <span className="min-w-0 flex-1 truncate text-[8px] leading-tight text-nq-foreground/95">
                    {r.name}
                  </span>
                  <span className="shrink-0 text-[8px] font-medium tabular-nums text-nq-primary/95">
                    {r.price}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Upload demo: user image, gold laser sweep, then service list.
 */
export function PhoneAiFileDemo({
  demo,
  scanDuration,
  menuRows,
  reduced,
}: PhoneAiFileDemoProps) {
  if (!demo.active) {
    return null;
  }

  if (demo.stage === "scan") {
    return (
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-nq-border/30 bg-nq-surface/20">
        <div className="relative mx-1.5 my-1 min-h-0 flex-1 overflow-hidden rounded-xl border border-nq-primary/20">
          {/* eslint-disable-next-line @next/next/no-img-element -- user-selected blob URL; not optimized static asset */}
          <img
            src={demo.objectUrl}
            alt=""
            className="h-full w-full object-cover"
          />
          {!reduced ? (
            <motion.div
              className="pointer-events-none absolute right-0 left-0 h-[3px] bg-gradient-to-r from-transparent via-nq-primary to-transparent"
              style={{
                top: 0,
                boxShadow: "0 0 16px rgba(212, 175, 55, 0.55), 0 0 2px rgba(255, 255, 255, 0.2)",
              }}
              initial={{ top: "0%" }}
              animate={{ top: "100%" }}
              transition={{ duration: scanDuration, ease: [0.22, 0.9, 0.36, 1] }}
            />
          ) : (
            <div
              className="pointer-events-none absolute right-0 bottom-0 left-0 h-px bg-nq-primary/50"
              aria-hidden
            />
          )}
        </div>
      </div>
    );
  }

  return <MenuListByCategory menuRows={menuRows} />;
}

type PhoneSceneStackProps = {
  displayScene: "hero" | "booking" | "ai";
  reduced: boolean;
  aiDemo: PhoneAiDemoState;
  childrenHero: ReactNode;
  booking: ReactNode;
  aiIdle: ReactNode;
  aiFileDemo: ReactNode;
};

/**
 * Cross-fade between phone scenes; AI file demo takes priority.
 */
export function PhoneSceneStack({
  displayScene,
  reduced,
  aiDemo,
  childrenHero,
  booking,
  aiIdle,
  aiFileDemo,
}: PhoneSceneStackProps) {
  const key = aiDemo.active
    ? `demo-${aiDemo.stage}`
    : displayScene;

  return (
    <div className="relative h-full min-h-0">
      <AnimatePresence mode="wait" initial={false}>
        {aiDemo.active ? (
          <motion.div
            key={key}
            className="absolute inset-0 flex min-h-0 flex-col"
            initial={reduced ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: -4 }}
            transition={{ duration: reduced ? 0 : 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            {aiFileDemo}
          </motion.div>
        ) : displayScene === "hero" ? (
          <motion.div
            key="hero"
            className="absolute inset-0 min-h-0"
            initial={reduced ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: -4 }}
            transition={{ duration: reduced ? 0 : 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            {childrenHero}
          </motion.div>
        ) : displayScene === "booking" ? (
          <motion.div
            key="booking"
            className="absolute inset-0 min-h-0 [transform:translateZ(0)]"
            initial={reduced ? false : { x: 22, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={reduced ? undefined : { x: -16, opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.32, ease: [0.32, 0.72, 0, 1] }}
          >
            {booking}
          </motion.div>
        ) : (
          <motion.div
            key="ai"
            className="absolute inset-0 min-h-0"
            initial={reduced ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: -4 }}
            transition={{ duration: reduced ? 0 : 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            {aiIdle}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
