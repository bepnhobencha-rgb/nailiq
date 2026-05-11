"use client";

import { motion } from "@/shared/lib/motionClient";
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
  // Group by category for headed rendering. If the salon hasn't
  // touched setup yet, every row is "other" — render a flat list with
  // no category header so the UI stays backward-compatible.
  const groups = groupByCategory(services);
  const flatLayout = groups.length === 1 && groups[0]?.category === "other";

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
        whileTap={{ scale: 0.99 }}
        transition={{
          type: "spring",
          stiffness: 420,
          damping: 28,
        }}
        aria-pressed={selected}
        onClick={() => onSelectService(s.id)}
        className={cn(
          "nq-booking-glass flex w-full min-w-0 min-h-[4.5rem] items-center justify-between gap-4 rounded-2xl px-4 py-3.5 text-left sm:min-h-[5rem] sm:gap-5 sm:px-5",
          !selected && "nq-booking-tile-interactive",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--booking-bg)]",
          selected
            ? "border border-[var(--salon-primary)] shadow-[var(--shadow-nq-tile-selected)]"
            : "border border-[var(--booking-border)] hover:border-[var(--booking-border)]",
        )}
      >
        <span className="min-w-0 flex-1 pr-2 text-[15px] font-medium leading-snug tracking-tight text-[var(--booking-text)] sm:text-base">
          {s.name}
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
        <div className="mt-6 space-y-7 lg:mt-8 lg:space-y-9">
          {groups.map((group) => (
            <div key={group.category} data-testid={`service-group-${group.category}`}>
              <h3
                className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--booking-text-muted)] lg:mb-4 lg:text-[0.8125rem]"
              >
                {t.serviceCategory[group.category]}
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 lg:gap-6 lg:gap-y-7">
                {group.items.map(renderTile)}
              </div>
            </div>
          ))}
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
