"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Stat = {
  /** Numeric headline used by the count-up animation. `null` = display `display` literally. */
  countTo: number | null;
  /** What the headline reads (also used as the static fallback). */
  display: string;
  /** Numeric prefix shown before the animated number (e.g. "$"). */
  prefix?: string;
  /** Trailing sub-line (e.g. "/day"). */
  sub: string;
  label: string;
  body: string;
};

export function LandingPainSection() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.pain,
    [language],
  );

  // Numeric pieces ($50, 200, 23%) are universal; the surrounding labels +
  // bodies + sub-lines flip with locale.
  const stats: Stat[] = useMemo(
    () => [
      {
        countTo: 200,
        display: "$50–200",
        prefix: "$50–",
        sub: "/day",
        label: t.stat1.label,
        body: t.stat1.body,
      },
      {
        countTo: 23,
        display: "23%",
        sub: language === "vi" ? "khách" : "of clients",
        label: t.stat2.label,
        body: t.stat2.body,
      },
      {
        countTo: null,
        display: t.stat3.display,
        sub: t.stat3.sub,
        label: t.stat3.label,
        body: t.stat3.body,
      },
    ],
    [language, t],
  );

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
            {t.eyebrow}
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-nq-foreground md:text-5xl lg:text-6xl">
            {t.h2}
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-nq-muted/70">{t.lede}</p>
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
              className="nq-pain-card rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-6 md:p-7"
            >
              <StatNumber stat={s} reduce={Boolean(reduce)} />
              <p className="mt-4 text-base font-semibold text-nq-foreground">
                {s.label}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-nq-muted/80">
                {s.body}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function StatNumber({ stat, reduce }: { stat: Stat; reduce: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  // BUG-14: initialize to the FINAL value so the static render (pre-scroll
  // and during SSR/hydrate) reads "$50–200" instead of "$50–0/day". When
  // the IntersectionObserver fires we reset to 0 and animate up.
  const [shown, setShown] = useState<number | null>(stat.countTo);

  useEffect(() => {
    if (stat.countTo == null) return;
    if (reduce) return;
    const node = ref.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            obs.disconnect();
          }
        }
      },
      { rootMargin: "-80px 0px" },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [reduce, stat.countTo]);

  useEffect(() => {
    if (stat.countTo == null) return;
    if (reduce) return;
    if (!inView) return;
    const target = stat.countTo;
    const duration = 1100;
    const start = performance.now();
    let raf = 0;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset before starting animation RAF loop
    setShown(0);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, reduce, stat.countTo]);

  return (
    <div ref={ref} className="flex items-baseline gap-1">
      <span className="text-6xl font-bold tracking-tight text-nq-primary tabular-nums [text-shadow:0_0_30px_rgba(212,175,55,0.18)] md:text-7xl lg:text-[88px] lg:leading-none">
        {stat.countTo == null
          ? stat.display
          : `${stat.prefix ?? ""}${shown ?? 0}${stat.display.endsWith("%") ? "%" : ""}`}
      </span>
      <span className="text-sm font-medium text-nq-muted">{stat.sub}</span>
    </div>
  );
}
