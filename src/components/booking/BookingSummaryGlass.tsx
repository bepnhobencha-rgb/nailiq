import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";

export function BookingSummaryGlass({
  t,
  shopLabel,
  serviceName,
  staffSummary,
  timeLabel,
  durationLabel,
  pricingLines,
  customerRows,
}: {
  t: BookingMessages;
  shopLabel: string;
  serviceName: string;
  staffSummary?: string | null;
  timeLabel: string;
  /** Pre-formatted "{n} min" (or "{n} min (incl. add-on)") for the Duration row. */
  durationLabel?: string | null;
  /** Optional price breakdown (confirm step). */
  pricingLines?: readonly { label: string; value: string; valueGold?: boolean }[];
  /** Flowchart step 6 — guest details in the review summary. */
  customerRows?: readonly { label: string; value: string }[];
}) {
  const rows: {
    label: string;
    value: string;
    valueGold: boolean;
  }[] = [
    { label: t.summaryShop, value: shopLabel, valueGold: false },
    { label: t.summaryService, value: serviceName, valueGold: false },
    ...(staffSummary != null && staffSummary !== ""
      ? [{ label: t.summaryStaff, value: staffSummary, valueGold: false }]
      : []),
    { label: t.summaryTime, value: timeLabel, valueGold: true },
    ...(durationLabel != null && durationLabel !== ""
      ? [{ label: t.summaryDuration, value: durationLabel, valueGold: false }]
      : []),
    ...(pricingLines ?? []).map((line) => ({
      label: line.label,
      value: line.value,
      valueGold: Boolean(line.valueGold),
    })),
    ...(customerRows ?? []).map((r) => ({
      label: r.label,
      value: r.value,
      valueGold: false,
    })),
  ];

  return (
    <div
      className="nq-booking-glass rounded-[1.25rem] px-5 py-5 [-webkit-font-smoothing:antialiased]"
      role="group"
    >
      <div className="space-y-3.5">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-4 border-b border-[var(--booking-border)] pb-3.5 text-[15px] last:border-b-0 last:pb-0 sm:text-base"
          >
            <span className="shrink-0 font-semibold text-[var(--booking-text-muted)]">
              {row.label}
            </span>
            <span
              className={cn(
                "min-w-0 shrink text-right text-[15px] font-semibold leading-snug tracking-tight sm:text-base",
                row.valueGold ? "text-[var(--salon-primary)]" : "text-[var(--booking-text)]",
              )}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
