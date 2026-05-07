"use client";

import { motion, useReducedMotion } from "@/shared/lib/motionClient";

type Quote = {
  initials: string;
  body: string;
  /** Person + role line. */
  author: string;
  /** Salon + city line. */
  venue: string;
};

const quotes: Quote[] = [
  {
    initials: "LN",
    body:
      "Perfect for busy salons. We stopped losing walk-ins because the queue is right there on iPad. Front desk finally has a clear picture.",
    author: "Lan Nguyen, Owner",
    venue: "Nails by Lan · Toronto",
  },
  {
    initials: "TM",
    body:
      "Vietnamese support saved us. Our customers book themselves now in Vietnamese and our phone barely rings — in a good way.",
    author: "Thuy Mai, Owner",
    venue: "Saigon Nail Studio · Houston",
  },
];

export function LandingSocialProof() {
  const reduce = useReducedMotion();

  return (
    <section className="relative bg-nq-bg py-14 md:py-20">
      <div className="mx-auto w-full max-w-5xl px-5 md:px-8">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="text-center"
        >
          <p className="text-[11px] font-semibold tracking-[0.24em] text-nq-primary uppercase">
            Trusted By
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-nq-foreground md:text-5xl">
            What salon owners say
          </h2>
          <p className="mt-3 text-[10px] font-semibold tracking-[0.18em] text-nq-muted uppercase">
            Early access feedback
          </p>
        </motion.div>

        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {quotes.map((q, i) => (
            <motion.figure
              key={q.initials}
              initial={reduce ? false : { opacity: 0, y: 24 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{
                duration: 0.55,
                delay: i * 0.1,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="nq-testimonial-card relative overflow-hidden rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-6 md:p-7"
            >
              <span
                aria-hidden
                className="pointer-events-none absolute -right-4 -top-10 select-none font-[family-name:var(--font-landing-playfair),ui-serif,Georgia,serif] text-[180px] italic leading-none text-nq-primary/[0.07] md:text-[220px]"
              >
                &ldquo;
              </span>
              <blockquote className="relative text-base leading-relaxed text-nq-foreground md:text-lg">
                {q.body}
              </blockquote>
              <figcaption className="relative mt-6 flex items-center gap-3">
                <span
                  aria-hidden
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-nq-primary/30 bg-nq-primary/15 text-sm font-semibold text-nq-primary"
                >
                  {q.initials}
                </span>
                <span className="leading-tight">
                  <span className="block text-sm font-semibold text-nq-foreground">
                    {q.author}
                  </span>
                  <span className="block text-xs text-nq-muted/80">
                    {q.venue}
                  </span>
                </span>
              </figcaption>
            </motion.figure>
          ))}
        </div>
      </div>
    </section>
  );
}
