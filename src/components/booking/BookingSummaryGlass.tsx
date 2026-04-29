import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";

export function BookingSummaryGlass({
  t,
  shopLabel,
  serviceName,
  staffSummary,
  timeLabel,
}: {
  t: BookingMessages;
  shopLabel: string;
  serviceName: string;
  staffSummary?: string | null;
  timeLabel: string;
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
            className="flex items-baseline justify-between gap-4 border-b border-white/[0.06] pb-3.5 text-[15px] last:border-b-0 last:pb-0 sm:text-base"
          >
            <span className="shrink-0 font-semibold text-nq-muted">
              {row.label}
            </span>
            <span
              className={cn(
                "min-w-0 shrink text-right text-[15px] font-semibold leading-snug tracking-tight sm:text-base",
                row.valueGold ? "text-nq-primary" : "text-nq-foreground",
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
