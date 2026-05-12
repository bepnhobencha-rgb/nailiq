"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "@/shared/lib/motionClient";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type { ServiceCategorySummary } from "@/shared/booking/loadServiceCategories";
import type { ServiceCategory } from "@/shared/booking/serviceCategory";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";

type ServiceGroup = {
  category: ServiceCategory;
  /** Localized header label sourced from the `service_categories` row. */
  label: string;
  items: BookingServiceItem[];
};

/** Group services by `category` in the order the DB returned. Categories
 *  not present in `categories` (e.g. a soft-deleted row that still has
 *  attached services) fall into an "Other"-styled bucket at the end so
 *  no service is silently dropped from the menu. */
function groupServices(
  services: readonly BookingServiceItem[],
  categories: readonly ServiceCategorySummary[],
): ServiceGroup[] {
  const buckets = new Map<ServiceCategory, BookingServiceItem[]>();
  for (const s of services) {
    const arr = buckets.get(s.category);
    if (arr) arr.push(s);
    else buckets.set(s.category, [s]);
  }

  const groups: ServiceGroup[] = [];
  const seen = new Set<string>();
  for (const cat of categories) {
    if (!buckets.has(cat.slug)) continue;
    groups.push({
      category: cat.slug,
      label: cat.nameEn,
      items: buckets.get(cat.slug) ?? [],
    });
    seen.add(cat.slug);
  }
  // Orphan slugs (deleted from `service_categories` but still on
  // service rows) — render under a single "Other" bucket so the
  // owner notices something needs cleanup.
  const orphans: BookingServiceItem[] = [];
  for (const [slug, items] of buckets) {
    if (!seen.has(slug)) orphans.push(...items);
  }
  if (orphans.length > 0) {
    groups.push({
      category: "other",
      label:
        categories.find((c) => c.slug === "other")?.nameEn ?? "Other",
      items: orphans,
    });
  }

  return groups;
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
  categories,
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
  /** Live category list from `loadServiceCategories`. Drives accordion
   *  order, group labels (EN — booking surface is EN-only), and the
   *  orphan-bucket fallback. */
  categories: readonly ServiceCategorySummary[];
  onSelectService: (id: string) => void;
  onNext: () => void;
}) {
  // Group by category for accordion rendering. If the salon hasn't
  // touched setup yet, every row is "other" — render a flat list with
  // no category header so the UI stays backward-compatible.
  const groups = groupServices(services, categories);
  const flatLayout = groups.length === 1 && groups[0]?.category === "other";
  const [openCategories, setOpenCategories] = useState<Set<ServiceCategory>>(
    () => initialOpenSet(groups),
  );

  // Per-tile expand state. Tapping a tile expands it (revealing the
  // full description + a "Select this service" button). Only one tile
  // can be expanded at a time. Selecting (committing) the service is a
  // separate action — only the explicit Select button calls
  // `onSelectService`, never the header tap. This prevents accidental
  // commits from a casual tap on a card.
  const [expandedServiceId, setExpandedServiceId] = useState<string | null>(
    null,
  );

  function toggleCategory(c: ServiceCategory) {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  function toggleExpand(id: string) {
    setExpandedServiceId((prev) => (prev === id ? null : id));
  }

  const renderTile = (s: BookingServiceItem) => {
    const isSelected = serviceId === s.id;
    const isExpanded = expandedServiceId === s.id;
    const durationText =
      s.totalMinutes > 0
        ? `${s.totalMinutes} ${t.minuteSuffixShort}`
        : t.serviceDurationFlexible;
    const detailId = `service-tile-${s.id}-detail`;
    const nameId = `service-tile-${s.id}-name`;
    // P1.4 — only show the description-toggle chevron when there is
    // actually a description to reveal. Otherwise the chevron is dead
    // weight and a tap-target hazard next to the main select area.
    const hasDescription =
      typeof s.description === "string" && s.description.trim().length > 0;

    return (
      <div
        key={s.id}
        role="group"
        aria-labelledby={nameId}
        data-testid="service-item"
        data-category={s.category}
        data-popular={s.isPopular || undefined}
        data-featured={s.isFeatured || undefined}
        data-expanded={isExpanded || undefined}
        data-selected={isSelected || undefined}
        className={cn(
          "nq-booking-glass overflow-hidden rounded-2xl",
          // Featured cards keep the subtle salon-brand ring.
          s.isFeatured && "ring-1 ring-[var(--salon-primary)]/40",
          isSelected
            ? "border border-[var(--salon-primary)] shadow-[var(--shadow-nq-tile-selected)]"
            : "border border-[var(--booking-border)] hover:border-[var(--booking-border)]",
        )}
      >
        {/* P1.4 — Main tile body is the select target. One click =
            commit the service, switch to gold border, light up Continue.
            Removes the prior two-step expand→select interaction that
            tested poorly with QA. The chevron sibling button (below)
            handles description preview separately. */}
        <div className="flex w-full min-w-0 items-stretch">
          <button
            type="button"
            onClick={() => onSelectService(s.id)}
            aria-pressed={isSelected}
            data-testid="service-tile-select"
            className={cn(
              // P2.8 — stacked layout (name on top, price/duration
              // below) replaces the prior side-by-side. Name always
              // gets full width so it can't visually collide with
              // the price column; meta row sits beneath, right-
              // aligned. Min-height bumped slightly so two-line
              // names + meta row fit without clipping.
              "flex w-full min-w-0 flex-col items-start gap-1.5 px-4 py-3.5 text-left sm:px-5 sm:py-4",
              s.isFeatured ? "min-h-[6rem]" : "min-h-[5rem]",
              !isSelected && "nq-booking-tile-interactive",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--booking-bg)] focus-visible:rounded-2xl",
            )}
          >
            {/* P2.8 — Name + badges row. `flex-wrap` lets the
                Popular/Featured chips drop to a second line on
                tiny screens. `break-words` handles long single
                tokens. */}
            <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span
                id={nameId}
                className="break-words text-[15px] font-medium leading-snug tracking-tight text-[var(--booking-text)] sm:text-base"
              >
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
            </div>
            {/* P2.8 — Meta row below name. Right-aligned so the
                price visually anchors against the card edge while
                still leaving room above for a two-line name. */}
            <div className="flex w-full items-baseline justify-between gap-3 text-[var(--booking-text-muted)]">
              <span className="text-sm font-medium tabular-nums tracking-tight sm:text-[15px]">
                {durationText}
              </span>
              {s.priceDisplay ? (
                <span className="text-sm font-semibold tabular-nums text-[var(--salon-primary)] sm:text-[15px]">
                  {s.priceDisplay}
                </span>
              ) : null}
            </div>
          </button>
          {hasDescription ? (
            <button
              type="button"
              onClick={() => toggleExpand(s.id)}
              aria-expanded={isExpanded}
              aria-controls={detailId}
              aria-label={t.serviceTileDescriptionAria.replace(
                "{service}",
                s.name,
              )}
              data-testid="service-tile-toggle"
              className="flex w-11 shrink-0 items-center justify-center border-l border-[var(--booking-border)] text-[var(--booking-text-muted)] hover:bg-[var(--booking-bg-input)] hover:text-[var(--booking-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--booking-bg)]"
            >
              <motion.svg
                aria-hidden
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                animate={{ rotate: isExpanded ? 180 : 0 }}
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 320, damping: 28 }
                }
              >
                <path d="M6 9l6 6 6-6" />
              </motion.svg>
            </button>
          ) : null}
        </div>

        <AnimatePresence initial={false}>
          {isExpanded && hasDescription ? (
            <motion.div
              key="detail"
              id={detailId}
              data-testid="service-tile-detail"
              initial={reducedMotion ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={
                reducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }
              }
              transition={
                reducedMotion
                  ? { duration: 0 }
                  : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }
              }
              className="overflow-hidden"
            >
              <div className="border-t border-[var(--booking-border)] px-4 py-3 sm:px-5 sm:py-4">
                <p
                  data-testid="service-description"
                  className="text-sm leading-relaxed text-[var(--booking-text-muted)] sm:text-[15px]"
                >
                  {s.description}
                </p>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
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
            const categoryLabel = group.label;
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
