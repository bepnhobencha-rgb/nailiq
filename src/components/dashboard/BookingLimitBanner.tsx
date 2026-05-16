"use client";

import { useState, useTransition } from "react";
import { createCheckoutSession } from "@/shared/dashboard/stripeActions";
import type { BookingLimitStatus } from "@/shared/dashboard/loadBookingLimitStatus";

/**
 * Receptionist Center upsell banner (Phase B).
 *
 * Three render states:
 *   - Hidden when the plan is unlimited.
 *   - Hidden when usage is under 80% of cap (no noise on a Free salon
 *     with 20/50 bookings).
 *   - Warning at 80–99% — yellow tint, "X / 50 lịch — nâng cấp Pro để
 *     bỏ giới hạn".
 *   - Blocking at 100% — red tint, same upgrade CTA. Server-side limit
 *     is what actually blocks new bookings; the banner is the upsell
 *     surface.
 *
 * Upgrade button trips the same `createCheckoutSession(slug, "pro")`
 * flow PricingPanel uses, redirecting to Stripe Checkout.
 */

type Copy = {
  warningTitle: string;
  blockingTitle: string;
  /** `{used}` and `{cap}` placeholders. */
  usageText: string;
  upgradeCta: string;
  manageCtaSettings: string;
  upgradeError: string;
};

type Props = {
  slug: string;
  status: BookingLimitStatus;
  copy: Copy;
};

export function BookingLimitBanner({ slug, status, copy }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Plan unlimited → don't render. Same for plans well under threshold.
  if (status.isUnlimited) return null;
  if (status.pctUsed === null || status.pctUsed < 0.8) return null;

  const isBlocking = status.count >= status.cap;
  const tone = isBlocking ? "error" : "warning";

  const onUpgrade = () => {
    setError(null);
    startTransition(async () => {
      const res = await createCheckoutSession(slug, "pro");
      if (res.ok) {
        window.location.assign(res.url);
        return;
      }
      setError(copy.upgradeError);
    });
  };

  return (
    <div
      role={isBlocking ? "alert" : "status"}
      data-testid="booking-limit-banner"
      data-tone={tone}
      className={
        isBlocking
          ? "flex flex-col gap-2 rounded-xl border border-nq-error/45 bg-nq-error/12 px-4 py-3 text-nq-foreground md:flex-row md:items-center md:justify-between"
          : "flex flex-col gap-2 rounded-xl border border-nq-warning/40 bg-nq-warning/10 px-4 py-3 text-nq-foreground md:flex-row md:items-center md:justify-between"
      }
    >
      <div className="flex flex-col gap-0.5 text-sm">
        <p className="font-semibold">
          {isBlocking ? copy.blockingTitle : copy.warningTitle}
        </p>
        <p className="text-nq-muted">
          {copy.usageText
            .replace("{used}", String(status.count))
            .replace("{cap}", String(status.cap))}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onUpgrade}
          disabled={pending}
          data-testid="booking-limit-banner-upgrade"
          className="inline-flex items-center justify-center rounded-full bg-nq-primary px-4 py-2 text-sm font-semibold text-nq-bg hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "…" : copy.upgradeCta}
        </button>
      </div>
      {error ? (
        <p className="text-xs text-nq-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
