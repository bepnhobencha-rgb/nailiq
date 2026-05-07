"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { cn } from "@/shared/lib/cn";

export function LandingHero() {
  const reduce = useReducedMotion();

  return (
    <section className="relative overflow-hidden pt-32 pb-16 md:pt-40 md:pb-24">
      <BackgroundGlow />

      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-5 md:grid-cols-2 md:gap-16 md:px-8 lg:gap-20">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={reduce ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="relative z-10"
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-nq-primary/40 bg-nq-primary/10 px-3 py-1 text-[11px] font-semibold tracking-[0.18em] text-nq-primary-soft uppercase">
            <span aria-hidden className="nq-spark-pulse">⚡</span>
            Trusted by salons in Canada &amp; Vietnam
          </span>

          <h1 className="mt-6 text-4xl font-semibold tracking-tight text-nq-foreground md:text-5xl lg:text-6xl">
            $29/month. Booking + walk-in queue,{" "}
            <span
              className="font-[family-name:var(--font-landing-playfair),ui-serif,Georgia,serif] italic font-bold text-nq-primary-soft"
              style={{ fontStyle: "italic" }}
            >
              built for nail salons.
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-lg leading-relaxed text-nq-muted/80 md:text-xl">
            3–5× cheaper than Booksy. Vietnamese-first. No missed calls.
          </p>

          <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <Link
              href="/register"
              className="inline-flex items-center justify-center rounded-full border border-nq-primary/50 bg-nq-primary px-6 py-3.5 text-base font-semibold text-nq-bg shadow-[0_8px_28px_-8px_rgba(212,175,55,0.55)] transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
            >
              Try free for 14 days
            </Link>
            <a
              href="#how-it-works"
              className="inline-flex items-center justify-center rounded-full px-4 py-3 text-sm font-medium text-nq-muted transition hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
            >
              See how it works ↓
            </a>
          </div>

          <p className="mt-4 text-xs text-nq-muted/80">
            No credit card · 14-day trial · Setup in 2 minutes
          </p>
        </motion.div>

        <motion.div
          initial={reduce ? false : { opacity: 0, x: 32, scale: 0.97 }}
          animate={reduce ? undefined : { opacity: 1, x: 0, scale: 1 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
          className="relative hidden md:block"
        >
          <BookingMockup reduce={reduce ?? false} />
        </motion.div>
      </div>
    </section>
  );
}

function BackgroundGlow() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-40 left-1/2 h-[640px] w-[640px] -translate-x-1/2 rounded-full bg-nq-primary/[0.07] blur-3xl" />
      <div className="absolute right-[-15%] top-1/3 h-[420px] w-[420px] rounded-full bg-nq-primary/[0.05] blur-3xl" />
      <div
        className="absolute right-[6%] top-[28%] h-[380px] w-[380px] rounded-full opacity-80 blur-2xl"
        style={{
          background:
            "radial-gradient(closest-side, rgba(212,175,55,0.16), rgba(212,175,55,0.05) 55%, rgba(212,175,55,0) 75%)",
        }}
      />
    </div>
  );
}

function BookingMockup({ reduce }: { reduce: boolean }) {
  const times = ["9:00", "9:30", "10:00", "10:30", "11:00", "11:30"];
  const staffNames = ["Lan", "Tina", "Mai", "Anh", "Linh"];

  return (
    <div className="relative">
      <div
        aria-hidden
        className="absolute -inset-10 rounded-[36px] bg-[radial-gradient(closest-side,rgba(212,175,55,0.22),rgba(212,175,55,0.06)_55%,transparent_80%)] blur-2xl"
      />
      <div
        aria-hidden
        className="absolute -inset-2 rounded-[28px] bg-gradient-to-br from-nq-primary/12 via-transparent to-transparent blur-xl"
      />
      <div className={cn(
        "relative rounded-2xl border border-nq-border/40 bg-nq-surface/60 p-4 shadow-[0_40px_100px_-30px_rgba(0,0,0,0.75),0_8px_28px_-8px_rgba(212,175,55,0.18),0_0_0_1px_rgba(212,175,55,0.14)] backdrop-blur-md",
        !reduce && "nq-mockup-float",
      )}>
        <div className="flex items-center gap-2 border-b border-nq-border/30 px-1 pb-3">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" aria-hidden />
          <span className="h-2.5 w-2.5 rounded-full bg-yellow-400/70" aria-hidden />
          <span className="h-2.5 w-2.5 rounded-full bg-green-400/70" aria-hidden />
          <div className="ml-3 flex-1 truncate rounded-md border border-nq-border/30 bg-nq-bg/40 px-3 py-1 text-[11px] text-nq-muted">
            nailiq.com/your-salon
          </div>
        </div>

        <div className="mt-4 grid grid-cols-[44px_repeat(5,minmax(0,1fr))] text-[10px] text-nq-muted">
          <div />
          {staffNames.map((s) => (
            <div key={s} className="px-1.5 pb-2 text-center font-semibold tracking-wide text-nq-foreground/80">
              {s}
            </div>
          ))}

          {times.map((t, rowIdx) => (
            <Row key={t} time={t} rowIdx={rowIdx} />
          ))}
        </div>

        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute left-12 right-4 top-[155px] flex items-center gap-2",
            !reduce && "animate-pulse",
          )}
        >
          <span className="relative -ml-3 flex h-2.5 w-2.5 items-center justify-center">
            <span className="absolute inline-flex h-full w-full rounded-full bg-nq-primary opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-nq-primary" />
          </span>
          <span className="block h-px flex-1 bg-gradient-to-r from-nq-primary/80 via-nq-primary/40 to-transparent" />
        </div>

        <motion.div
          initial={reduce ? false : { opacity: 0, scale: 0.92 }}
          animate={reduce ? undefined : { opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, delay: 1.2, ease: [0.22, 1, 0.36, 1] }}
          className="absolute right-5 bottom-5 rounded-xl border border-nq-success/40 bg-nq-success/15 px-3 py-2 text-[11px] font-medium text-nq-success backdrop-blur-md"
        >
          ● New booking
        </motion.div>
      </div>
    </div>
  );
}

function Row({ time, rowIdx }: { time: string; rowIdx: number }) {
  const blocks = getBlocks(rowIdx);
  return (
    <>
      <div className="border-t border-nq-border/15 py-3 pr-2 text-right text-[10px] text-nq-muted">
        {time}
      </div>
      {[0, 1, 2, 3, 4].map((col) => {
        const block = blocks[col];
        return (
          <div
            key={col}
            className="relative border-t border-nq-border/15 px-1 py-1"
          >
            {block ? (
              <div
                className={cn(
                  "rounded-md px-2 py-1.5 text-[9px] font-medium leading-tight",
                  block.kind === "walkin"
                    ? "border border-nq-success/40 bg-nq-success/15 text-nq-success"
                    : "border border-nq-primary/40 bg-nq-primary/15 text-nq-primary-soft",
                )}
              >
                <div className="truncate">{block.client}</div>
                <div className="truncate text-[8.5px] opacity-70">{block.service}</div>
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

type Block = { client: string; service: string; kind: "booking" | "walkin" };

function getBlocks(rowIdx: number): (Block | null)[] {
  if (rowIdx === 0) {
    return [
      null,
      null,
      { client: "Walk-in", service: "Quick mani", kind: "walkin" },
      null,
      null,
    ];
  }
  if (rowIdx === 1) {
    return [
      { client: "Lan", service: "Gel manicure", kind: "booking" },
      null,
      { client: "Walk-in", service: "Quick mani", kind: "walkin" },
      null,
      null,
    ];
  }
  if (rowIdx === 2) {
    return [
      { client: "Lan", service: "Gel manicure", kind: "booking" },
      { client: "Tina", service: "Pedicure", kind: "booking" },
      null,
      null,
      { client: "Linh", service: "Nail art", kind: "booking" },
    ];
  }
  if (rowIdx === 3) {
    return [
      null,
      { client: "Tina", service: "Pedicure", kind: "booking" },
      null,
      { client: "Anh", service: "Acrylic full", kind: "booking" },
      { client: "Linh", service: "Nail art", kind: "booking" },
    ];
  }
  if (rowIdx === 4) {
    return [null, null, null, { client: "Anh", service: "Acrylic full", kind: "booking" }, null];
  }
  return [null, null, null, null, null];
}
