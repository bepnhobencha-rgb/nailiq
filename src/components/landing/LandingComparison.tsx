"use client";

import { useMemo } from "react";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { cn } from "@/shared/lib/cn";

/** Renders either a green check, a red X, or a plain text string for
 *  a comparison cell. `true` → supported, `null` → unsupported,
 *  any string → rendered as-is (e.g. "$29/mo"). */
function CompareCell({
  value,
  highlight,
}: {
  value: string | true | null;
  highlight: boolean;
}) {
  if (value === true) {
    return (
      <span
        aria-label="Yes"
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-full",
          highlight
            ? "bg-nq-primary/20 text-nq-primary-soft"
            : "bg-nq-success/15 text-nq-success",
        )}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
          aria-hidden
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }
  if (value === null) {
    return (
      <span
        aria-label="No"
        className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-nq-foreground/[0.06] text-nq-muted/50"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
          aria-hidden
        >
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "text-sm md:text-base",
        highlight
          ? "font-semibold text-nq-primary-soft"
          : "text-nq-foreground/80",
      )}
    >
      {value}
    </span>
  );
}

export function LandingComparison() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.compare,
    [language],
  );

  // Highlight = the NailIQ column (index 1 in headers, index 0 in cells
  // since cells excludes the label column). Defense: derive from name
  // match so a future header reorder doesn't break the highlight.
  const nailiqColIndex = t.headers.findIndex((h) => h === "NailIQ");
  // `cells` is 0-indexed against competitors (label column stripped),
  // and `headers` is 0-indexed including the label column. So the
  // cells index for NailIQ is `headers index - 1`.
  const nailiqCellIndex = nailiqColIndex > 0 ? nailiqColIndex - 1 : 0;

  return (
    <section id="compare" className="relative bg-nq-bg py-14 md:py-20">
      <div className="mx-auto w-full max-w-5xl px-5 md:px-8">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="text-center"
        >
          <p className="text-[11px] font-semibold tracking-[0.24em] text-nq-primary uppercase">
            {t.eyebrow}
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-nq-foreground md:text-4xl lg:text-5xl">
            {t.h2}
          </h2>
          <p className="mt-3 text-base text-nq-muted/80 md:text-lg">{t.sub}</p>
        </motion.div>

        {/* Desktop / tablet: full table */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 24 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="mt-10 hidden overflow-hidden rounded-2xl border border-nq-border/40 bg-nq-surface/40 md:block"
        >
          <table className="w-full">
            <thead>
              <tr className="border-b border-nq-border/40">
                {t.headers.map((h, i) => {
                  const isNailIq = i === nailiqColIndex;
                  return (
                    <th
                      key={h || `col-${i}`}
                      scope={i === 0 ? "col" : "col"}
                      className={cn(
                        "px-4 py-5 text-left text-sm font-semibold",
                        i === 0 && "text-nq-muted",
                        isNailIq && "bg-nq-primary/10 text-nq-primary-soft",
                        !isNailIq && i !== 0 && "text-nq-foreground/70",
                      )}
                    >
                      {h}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, ri) => (
                <tr
                  key={row.label}
                  className={cn(
                    "border-b border-nq-border/20 last:border-b-0",
                  )}
                >
                  <th
                    scope="row"
                    className="px-4 py-4 text-left text-sm font-medium text-nq-foreground/80"
                  >
                    {row.label}
                  </th>
                  {row.cells.map((cell, ci) => {
                    const isNailIq = ci === nailiqCellIndex;
                    return (
                      <td
                        key={`${row.label}-${ci}`}
                        className={cn(
                          "px-4 py-4",
                          isNailIq && "bg-nq-primary/[0.06]",
                          ri === t.rows.length - 1 &&
                            isNailIq &&
                            "rounded-b-2xl",
                        )}
                      >
                        <CompareCell value={cell} highlight={isNailIq} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </motion.div>

        {/* Mobile: stacked cards per competitor, NailIQ first + highlighted */}
        <div className="mt-10 space-y-4 md:hidden">
          {/* Build competitor list — index 0 in headers is label col,
              skip it. Reorder so NailIQ comes first for mobile UX. */}
          {(() => {
            const competitors = t.headers.slice(1);
            const orderedIdx = competitors
              .map((_, i) => i)
              .sort((a, b) =>
                a === nailiqCellIndex ? -1 : b === nailiqCellIndex ? 1 : 0,
              );
            return orderedIdx.map((cellIdx) => {
              const name = competitors[cellIdx];
              const isNailIq = cellIdx === nailiqCellIndex;
              return (
                <div
                  key={name}
                  className={cn(
                    "rounded-2xl border p-5",
                    isNailIq
                      ? "border-nq-primary/50 bg-gradient-to-b from-nq-surface/70 to-nq-bg/40 shadow-[0_18px_60px_-30px_rgba(212,175,55,0.4)]"
                      : "border-nq-border/40 bg-nq-surface/40",
                  )}
                >
                  <p
                    className={cn(
                      "text-base font-semibold",
                      isNailIq
                        ? "text-nq-primary-soft"
                        : "text-nq-foreground/80",
                    )}
                  >
                    {name}
                  </p>
                  <dl className="mt-3 space-y-2.5">
                    {t.rows.map((row) => (
                      <div
                        key={`${name}-${row.label}`}
                        className="flex items-center justify-between gap-3 border-b border-nq-border/15 pb-2 last:border-b-0 last:pb-0"
                      >
                        <dt className="text-xs font-medium uppercase tracking-wider text-nq-muted">
                          {row.label}
                        </dt>
                        <dd className="text-sm">
                          <CompareCell
                            value={row.cells[cellIdx] ?? null}
                            highlight={isNailIq}
                          />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              );
            });
          })()}
        </div>

        <p className="mt-6 text-center text-xs text-nq-muted/70">
          {t.footnote}
        </p>
      </div>
    </section>
  );
}
