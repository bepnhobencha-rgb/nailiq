"use client";

import { useEffect, useState, useCallback } from "react";

const DISMISS_KEY_PREFIX = "nq-qr-dismiss-";
const DISMISS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DISMISS_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const MAX_DISMISSALS_BEFORE_COOLDOWN = 3;

export type QuickRebookData = {
  service_id: string;
  service_name: string;
  staff_id: string | null;
  staff_name: string | null;
  start_time_utc: string;
  end_time_utc: string;
  price_cents: number | null;
  weekday_name: string | null;
  hour_label: string | null;
};

type PatternResponse = {
  available: boolean;
  pattern?: {
    confidence: number;
    recurring_weekday: number | null;
    weekday_name: string | null;
    recurring_hour: number | null;
    hour_label: string | null;
    usual_service_id: string | null;
    service_name: string | null;
    service_price_cents: number | null;
    usual_staff_id: string | null;
    staff_name: string | null;
    recurrence_frequency_days: number | null;
    usual_total_cents: number | null;
    last_booking_at: string | null;
  };
};

type DismissRecord = {
  count: number;
  timestamps: number[];
  cooldownUntil: number | null;
};

function getDismissRecord(key: string): DismissRecord {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { count: 0, timestamps: [], cooldownUntil: null };
    return JSON.parse(raw) as DismissRecord;
  } catch {
    return { count: 0, timestamps: [], cooldownUntil: null };
  }
}

function saveDismissRecord(key: string, record: DismissRecord): void {
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // localStorage might be unavailable
  }
}

function shouldShowQuickRebook(salonId: string, phone: string): boolean {
  const key = `${DISMISS_KEY_PREFIX}${salonId}-${phone}`;
  const record = getDismissRecord(key);

  if (record.cooldownUntil && Date.now() < record.cooldownUntil) {
    return false;
  }

  // Prune timestamps older than 30 days
  const cutoff = Date.now() - DISMISS_WINDOW_MS;
  const recentDismissals = record.timestamps.filter((t) => t > cutoff);

  if (recentDismissals.length >= MAX_DISMISSALS_BEFORE_COOLDOWN) {
    // Enter 90-day cooldown
    const updated: DismissRecord = {
      count: record.count,
      timestamps: recentDismissals,
      cooldownUntil: Date.now() + DISMISS_COOLDOWN_MS,
    };
    saveDismissRecord(key, updated);
    return false;
  }

  return true;
}

function recordDismissal(salonId: string, phone: string): void {
  const key = `${DISMISS_KEY_PREFIX}${salonId}-${phone}`;
  const record = getDismissRecord(key);
  const cutoff = Date.now() - DISMISS_WINDOW_MS;
  const recentDismissals = record.timestamps.filter((t) => t > cutoff);
  recentDismissals.push(Date.now());

  let cooldownUntil = record.cooldownUntil;
  if (recentDismissals.length >= MAX_DISMISSALS_BEFORE_COOLDOWN) {
    cooldownUntil = Date.now() + DISMISS_COOLDOWN_MS;
  }

  saveDismissRecord(key, {
    count: record.count + 1,
    timestamps: recentDismissals,
    cooldownUntil,
  });
}

type Props = {
  salonId: string;
  phone: string;
  onBook: (data: QuickRebookData) => void;
  onDismiss: () => void;
};

/**
 * QuickRebookButton — shown on the public booking page after OTP verification.
 * Fetches the customer's booking pattern and surfaces a one-tap "Book your usual"
 * card if confidence ≥ 0.70 and last booking was < 6 months ago.
 */
export function QuickRebookButton({ salonId, phone, onBook, onDismiss }: Props) {
  const [pattern, setPattern] = useState<PatternResponse["pattern"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [booking, setBooking] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!shouldShowQuickRebook(salonId, phone)) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchPattern() {
      try {
        const res = await fetch(
          `/api/quick-rebook?salon_id=${encodeURIComponent(salonId)}&phone=${encodeURIComponent(phone)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as PatternResponse;
        if (!cancelled && data.available && data.pattern) {
          setPattern(data.pattern);
          setVisible(true);
        }
      } catch {
        // Silently fail — this is an enhancement, not critical path
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchPattern();
    return () => {
      cancelled = true;
    };
  }, [salonId, phone]);

  const handleBook = useCallback(async () => {
    if (!pattern || booking) return;
    setBooking(true);
    try {
      const res = await fetch("/api/quick-rebook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salon_id: salonId, phone }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        booking_id?: string;
        start_time_utc?: string;
        end_time_utc?: string;
        service_name?: string;
        staff_name?: string;
        error?: string;
      };
      if (res.ok && data.ok) {
        onBook({
          service_id: pattern.usual_service_id ?? "",
          service_name: data.service_name ?? pattern.service_name ?? "",
          staff_id: pattern.usual_staff_id,
          staff_name: data.staff_name ?? pattern.staff_name,
          start_time_utc: data.start_time_utc ?? "",
          end_time_utc: data.end_time_utc ?? "",
          price_cents: pattern.service_price_cents,
          weekday_name: pattern.weekday_name,
          hour_label: pattern.hour_label,
        });
      }
    } catch {
      // booking failed — stay on screen so user can try manual
    } finally {
      setBooking(false);
    }
  }, [pattern, booking, salonId, phone, onBook]);

  const handleDismiss = useCallback(() => {
    recordDismissal(salonId, phone);
    setVisible(false);
    onDismiss();
  }, [salonId, phone, onDismiss]);

  if (loading || !visible || !pattern) return null;

  const timeLabel =
    pattern.weekday_name && pattern.hour_label
      ? `${pattern.weekday_name}s at ${pattern.hour_label}`
      : pattern.weekday_name ?? pattern.hour_label ?? "your usual time";

  const priceLabel =
    pattern.service_price_cents !== null && pattern.service_price_cents !== undefined
      ? `$${(pattern.service_price_cents / 100).toFixed(2)}`
      : null;

  return (
    <div
      className="fade-in w-full rounded-2xl border p-4"
      style={{
        background: "var(--color-nq-navy-glass, rgba(15,23,42,0.58))",
        borderColor: "rgba(212,175,55,0.28)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }}
      role="region"
      aria-label="Quick rebook suggestion"
    >
      {/* Header */}
      <div className="mb-3 flex items-center gap-2">
        <span
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm"
          style={{ background: "rgba(212,175,55,0.15)", color: "#d4af37" }}
          aria-hidden
        >
          ⚡
        </span>
        <p
          className="text-sm font-semibold"
          style={{ color: "#d4af37" }}
        >
          Ready for your usual?
        </p>
      </div>

      {/* Details */}
      <div className="mb-4 space-y-1.5 pl-10">
        {pattern.service_name ? (
          <p className="text-[15px] font-medium text-white">
            {pattern.service_name}
            {priceLabel ? (
              <span className="ml-2 text-sm font-normal" style={{ color: "#a1a1aa" }}>
                {priceLabel}
              </span>
            ) : null}
          </p>
        ) : null}
        <p className="text-sm" style={{ color: "#a1a1aa" }}>
          {timeLabel}
        </p>
        {pattern.staff_name ? (
          <p className="text-sm" style={{ color: "#a1a1aa" }}>
            with {pattern.staff_name}
          </p>
        ) : null}
      </div>

      {/* Actions — large touch targets for mobile */}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          disabled={booking}
          onClick={() => void handleBook()}
          className="relative flex min-h-[52px] w-full items-center justify-center overflow-hidden rounded-full text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
          style={{
            background: booking
              ? "rgba(212,175,55,0.4)"
              : "linear-gradient(90deg,#d4af37,#f3eacb,#d4af37)",
            backgroundSize: "200% auto",
            color: "#0b0c10",
          }}
          aria-busy={booking}
        >
          {booking ? (
            <span className="inline-flex items-center gap-2">
              <span
                className="inline-block h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin"
                aria-hidden
              />
              Booking…
            </span>
          ) : (
            <span>Book this →</span>
          )}
        </button>

        <button
          type="button"
          onClick={handleDismiss}
          className="min-h-[44px] w-full rounded-full text-sm font-medium transition-colors hover:bg-white/5"
          style={{ color: "#a1a1aa" }}
        >
          Choose different
        </button>
      </div>
    </div>
  );
}

export default QuickRebookButton;
