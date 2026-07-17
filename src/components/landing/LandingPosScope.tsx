"use client";

/**
 * "POS Compatibility" scope table — 3 columns (Included / Supported
 * where available / Not included). Sits after pricing so the salon
 * owner knows exactly what the pilot delivers and what it does not
 * before they apply.
 */
import { useMemo, type ReactNode } from "react";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { cn } from "@/shared/lib/cn";

type Kind = "included" | "supported" | "not_included";

function StatusIcon({ kind }: { kind: Kind }) {
  const cls =
    kind === "included"
      ? "bg-nq-success/15 text-nq-success"
      : kind === "supported"
        ? "bg-nq-primary/15 text-nq-primary"
        : "bg-nq-error/10 text-nq-error";
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
        cls,
      )}
    >
      {kind === "not_included" ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3 w-3"
        >
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3 w-3"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  );
}

function ScopeColumn({
  title,
  items,
  kind,
  headerAccent,
}: {
  title: string;
  items: ReadonlyArray<string>;
  kind: Kind;
  headerAccent: ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-nq-border/30 bg-nq-surface/40 p-6 md:p-7">
      <div className="flex items-center gap-2">
        {headerAccent}
        <h3 className="text-base font-semibold text-nq-foreground md:text-lg">
          {title}
        </h3>
      </div>
      <ul className="mt-5 space-y-2.5">
        {items.map((i) => (
          <li
            key={i}
            className="flex items-start gap-2.5 text-sm leading-relaxed text-nq-foreground/85"
          >
            <StatusIcon kind={kind} />
            <span>{i}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LandingPosScope() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.posScope,
    [language],
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
          <h2 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight text-nq-foreground md:text-4xl lg:text-5xl">
            {t.h2}
          </h2>
          <p className="mt-4 max-w-3xl text-base leading-relaxed text-nq-muted/85 md:text-lg">
            {t.intro}
          </p>
        </motion.div>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 20 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="mt-10 grid gap-5 md:grid-cols-3 md:gap-6"
        >
          <ScopeColumn
            title={t.includedTitle}
            items={t.includedItems}
            kind="included"
            headerAccent={
              <span
                aria-hidden
                className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-nq-success/15 text-nq-success"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className="h-3.5 w-3.5"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
            }
          />
          <ScopeColumn
            title={t.supportedTitle}
            items={t.supportedItems}
            kind="supported"
            headerAccent={
              <span
                aria-hidden
                className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-nq-primary/15 text-nq-primary"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className="h-3.5 w-3.5"
                >
                  <circle cx="12" cy="12" r="4" />
                </svg>
              </span>
            }
          />
          <ScopeColumn
            title={t.notIncludedTitle}
            items={t.notIncludedItems}
            kind="not_included"
            headerAccent={
              <span
                aria-hidden
                className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-nq-error/10 text-nq-error"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className="h-3.5 w-3.5"
                >
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </span>
            }
          />
        </motion.div>

        <p className="mt-8 max-w-3xl text-sm leading-relaxed text-nq-muted/75 md:text-base">
          {t.closing}
        </p>
      </div>
    </section>
  );
}
