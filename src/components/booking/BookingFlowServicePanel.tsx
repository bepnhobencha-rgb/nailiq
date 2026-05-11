"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "@/shared/lib/motionClient";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import {
  SERVICE_CATEGORIES,
  type ServiceCategory,
} from "@/shared/booking/serviceCategory";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";

/** Group services by `category`, preserving SERVICE_CATEGORIES order.
 *  Empty groups are dropped; this lets the renderer simply iterate. */
function groupByCategory(
  services: readonly BookingServiceItem[],
): Array<{ category: ServiceCategory; items: BookingServiceItem[] }> {
  const buckets = new Map<ServiceCategory, BookingServiceItem[]>();
  for (const s of services) {
    const arr = buckets.get(s.category);
    if (arr) arr.push(s);
    else buckets.set(s.category, [s]);
  }
  return SERVICE_CATEGORIES.filter((c) => buckets.has(c)).map((c) => ({
    category: c,
    items: buckets.get(c) ?? [],
  }));
}

/** Initial accordion state: first category open, rest closed. */
function initialOpenSet(groups: ReadonlyArray<{ category: ServiceCategory }>) {
  const set = new Set<ServiceCategory>();
  const first = groups[0]?.category;
  if (first) set.add(first);
  return set;
}

export function BookingFlowServicePanel({
  t,
  services,
  serviceId,
  error,
  stepDir,
  reducedMotion,
  stepTransition,
  onSelectService,
  onNext,
}: {
  t: BookingMessages;
  services: readonly BookingServiceItem[];
  serviceId: string | null;
  error: string | null;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  onSelectService: (id: string) => void;
  onNext: () => void;
}) {
  // Group by category for accordion rendering. If the salon hasn't
  // touched setup yet, every row is "other" — render a flat list with
  // no category header so the UI stays backward-compatible.
  const groups = groupByCategory(services);
  const flatLayout = groups.length === 1 && groups[0]?.category === "other";
  const [openCategories, setOpenCategories] = useState<Set<ServiceCategory>>(
    () => initialOpenSet(groups),
  );

  function toggleCategory(c: ServiceCategory) {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  const renderTile = (s: BookingServiceItem) => {
    const selected = serviceId === s.id;
    const durationText =
      s.totalMinutes > 0
        ? `${s.totalMinutes} ${t.minuteSuffixShort}`
        : t.serviceDurationFlexible;

    return (
      <motion.button
        key={s.id}
        type="button"
        data-testid="service-item"
        data-category={s.category}
        data-popular={s.isPopular || undefined}
        data-featured={s.isFeatured || undefined}
        whileTap={{ scale: 0.99 }}
        transition={{
          type: "spring",
          stiffness: 420,
          damping: 28,
        }}
        aria-pressed={selected}
        onClick={() => onSelectService(s.id)}
        className={cn(
          "nq-booking-glass flex w-full min-w-0 items-start justify-between gap-4 rounded-2xl px-4 text-left sm:gap-5 sm:px-5",
          // Featured cards get extra vertical breathing room + a subtle
          // ring tinted with the salon's brand color. Tailwind's
          // arbitrary-value opacity modifier (`/40`) handles the
          // alpha against the hex value of `--salon-primary`.
          s.isFeatured
            ? "min-h-[5.5rem] py-4 sm:min-h-[6rem] sm:py-4 ring-1 ring-[var(--salon-primary)]/40"
            : "min-h-[4.5rem] py-3.5 sm:min-h-[5rem]",
          !selected && "nq-booking-tile-interactive",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--booking-bg)]",
          selected
            ? "border border-[var(--salon-primary)] shadow-[var(--shadow-nq-tile-selected)]"
            : "border border-[var(--booking-border)] hover:border-[var(--booking-border)]",
        )}
      >
        <span className="min-w-0 flex-1 pr-2">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[15px] font-medium leading-snug tracking-tight text-[var(--booking-text)] sm:text-base">
              {s.name}
            </span>
            {s.isPopular ? (
              <span
                data-testid="service-popular-badge"
                className="rounded-full bg-[var(--salon-primary)]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--salon-primary)]"
              >
                {t.popularBadge}
              </span>
            ) : null}
            {s.isFeatured ? (
              <span
                data-testid="service-featured-badge"
                className="rounded-full border border-[var(--salon-primary)]/40 bg-[var(--salon-primary)]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--salon-primary)]"
              >
                {t.featuredBadge}
              </span>
            ) : null}
          </span>
          {s.description ? (
            <span
              data-testid="service-description"
              // `line-clamp-2` lets descriptions occupy up to two lines
              // and ellipsis only if they overflow that. The previous
              // `truncate` (`white-space: nowrap`) collapsed the line
              // to one row, which on cards with a duration+price gutter
              // showed only ~8 characters before "…".
              className="mt-1 line-clamp-2 text-xs leading-snug text-[var(--booking-text-muted)] sm:text-[13px]"
            >
              {s.description}
            </span>
          ) : null}
        </span>
        <div className="flex shrink-0 flex-col items-end gap-1 text-right">
          <span className="text-sm font-medium tabular-nums tracking-tight text-[var(--booking-text-muted)] sm:text-[15px]">
            {durationText}
          </span>
          {s.priceDisplay ? (
            <span className="text-sm font-semibold tabular-nums text-[var(--salon-primary)] sm:text-[15px]">
              {s.priceDisplay}
            </span>
          ) : null}
        </div>
      </motion.button>
    );
  };

  return (
    <motion.section
      key="service"
      role="group"
      aria-labelledby="svc-heading"
      custom={stepDir}
      variants={bookingStepVariants}
      initial={reducedMotion ? false : "initial"}
      animate="animate"
      exit="exit"
      transition={stepTransition}
      className="will-change-transform"
    >
      <h2
        id="svc-heading"
        className="text-lg font-semibold tracking-tight text-[var(--booking-text)] sm:text-xl lg:text-[1.625rem] lg:tracking-[-0.02em]"
      >
        {t.stepServiceHeading}
      </h2>

      {flatLayout ? (
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:mt-8 lg:grid-cols-3 lg:gap-6 lg:gap-y-7">
          {groups[0]!.items.map(renderTile)}
        </div>
      ) : (
        <div className="mt-6 space-y-3 lg:mt-8 lg:space-y-4">
          {groups.map((group) => {
            const isOpen = openCategories.has(group.category);
            const categoryLabel = t.serviceCategory[group.category];
            return (
              <div
                key={group.category}
                data-testid={`service-group-${group.category}`}
                className="rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-input)]/30"
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`service-group-${group.category}-panel`}
                  aria-label={t.categoryToggleAria.replace(
                    "{category}",
                    categoryLabel,
                  )}
                  data-testid={`service-group-${group.category}-toggle`}
                  onClick={() => toggleCategory(group.category)}
                  className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left sm:px-5 sm:py-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--booking-bg)] rounded-2xl"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.12em] text-[var(--booking-text)] sm:text-[0.9375rem]">
                    {categoryLabel}
                    <span className="text-xs font-medium normal-case tracking-normal text-[var(--booking-text-muted)]">
                      {group.items.length}
                    </span>
                  </span>
                  <motion.svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    className="h-4 w-4 text-[var(--booking-text-muted)]"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    animate={{ rotate: isOpen ? 180 : 0 }}
                    transition={
                      reducedMotion
                        ? { duration: 0 }
                        : { type: "spring", stiffness: 320, damping: 28 }
                    }
                  >
                    <path d="M6 9l6 6 6-6" />
                  </motion.svg>
                </button>
                <AnimatePresence initial={false}>
                  {isOpen ? (
                    <motion.div
                      key="panel"
                      id={`service-group-${group.category}-panel`}
                      initial={
                        reducedMotion ? false : { opacity: 0, height: 0 }
                      }
                      animate={{ opacity: 1, height: "auto" }}
                      exit={
                        reducedMotion
                          ? { opacity: 0 }
                          : { opacity: 0, height: 0 }
                      }
                      transition={
                        reducedMotion
                          ? { duration: 0 }
                          : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }
                      }
                      className="overflow-hidden"
                    >
                      <div className="grid grid-cols-1 gap-3 px-3 pb-3 sm:grid-cols-2 sm:gap-4 sm:px-4 sm:pb-4 lg:grid-cols-3 lg:gap-6">
                        {group.items.map(renderTile)}
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-10 flex flex-col items-end gap-2 lg:mt-12">
        {error ? (
          <p
            className="self-stretch text-right text-sm text-nq-error"
            role="alert"
            data-testid="booking-service-error"
          >
            {error}
          </p>
        ) : null}
        <LuxuryBookingCta onClick={onNext}>{t.next}</LuxuryBookingCta>
      </div>
    </motion.section>
  );
}
