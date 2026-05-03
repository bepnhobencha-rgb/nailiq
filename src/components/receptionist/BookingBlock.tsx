"use client";

import { cn } from "@/shared/lib/cn";

export interface BookingBlockProps {
  bookingId: string;
  clientName: string;
  serviceName: string;
  status: "pending" | "confirmed" | "in_progress" | "completed";
  source: "appointment" | "walkin";
  startTimeLabel: string;
  priceCents: number | null;
  leftPx: number;
  widthPx: number;
  onClick?: () => void;
}

const STATUS_STYLES: Record<
  BookingBlockProps["status"],
  { root: string; meta: string }
> = {
  pending: {
    root: "bg-nq-primary-soft text-nq-navy-deep",
    meta: "text-nq-navy-deep/85",
  },
  confirmed: {
    root: "bg-nq-info text-nq-foreground",
    meta: "text-nq-foreground/85",
  },
  in_progress: {
    root: "bg-nq-success text-nq-foreground",
    meta: "text-nq-foreground/85",
  },
  completed: {
    root: "bg-nq-muted/45 text-nq-foreground",
    meta: "text-nq-foreground/70",
  },
};

function formatPrice(priceCents: number | null): string {
  if (priceCents == null) return "—";
  return (priceCents / 100).toFixed(2);
}

export function BookingBlock(props: BookingBlockProps) {
  const {
    bookingId,
    clientName,
    serviceName,
    status,
    source,
    startTimeLabel,
    priceCents,
    leftPx,
    widthPx,
    onClick,
  } = props;

  const styles = STATUS_STYLES[status];
  const pricePart =
    priceCents != null ? `$${formatPrice(priceCents)}` : formatPrice(priceCents);
  const meta = `${startTimeLabel} · ${serviceName} · ${pricePart}`;

  const isWalkin = source === "walkin";
  const isCompleted = status === "completed";

  const commonClass = cn(
    "absolute top-1.5 bottom-1.5 min-h-11 rounded-lg px-2.5 py-1.5 text-left shadow-none transition-[transform,box-shadow] duration-[var(--duration-nq-fast,150ms)] ease-[var(--ease-nq-out,cubic-bezier(0.22,1,0.36,1))] motion-safe:hover:-translate-y-px motion-safe:hover:shadow-nq-card",
    styles.root,
    isWalkin && "border-l-[3px] border-nq-primary",
    isCompleted && "opacity-70",
    onClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
  );

  const style = {
    left: leftPx,
    width: Math.max(0, widthPx - 4),
  } as const;

  const inner = (
    <>
      <p className="truncate text-sm font-semibold leading-snug">{clientName}</p>
      <p
        className={cn(
          "truncate font-mono text-[11px] leading-snug",
          styles.meta,
        )}
      >
        {meta}
      </p>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        data-testid={`booking-block-${bookingId}`}
        className={cn(commonClass, "appearance-none border-0")}
        style={style}
        aria-label={`Booking ${bookingId}: ${clientName}`}
        onClick={onClick}
      >
        {inner}
      </button>
    );
  }

  return (
    <div
      className={commonClass}
      style={style}
      data-booking-id={bookingId}
      data-testid={`booking-block-${bookingId}`}
    >
      {inner}
    </div>
  );
}
