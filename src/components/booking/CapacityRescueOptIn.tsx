"use client";

import { useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";

type CapacityRescueOptInProps = {
  t: BookingMessages;
  initialEmail: string;
  joined: boolean;
  submitting: boolean;
  error: string | null;
  onSubmit: (email: string) => void;
};

export function CapacityRescueOptIn({
  t,
  initialEmail,
  joined,
  submitting,
  error,
  onSubmit,
}: CapacityRescueOptInProps) {
  const [email, setEmail] = useState(initialEmail);
  const emailInputId = useId();

  if (joined) {
    return (
      <p
        data-testid="capacity-rescue-joined"
        role="status"
        className="rounded-xl border border-nq-success/40 bg-nq-success/10 px-4 py-3 text-sm font-medium text-nq-success"
      >
        {t.capacityRescueJoined}
      </p>
    );
  }

  const emailValid = isValidEmailFormat(email.trim());
  return (
    <section
      data-testid="capacity-rescue-opt-in"
      aria-labelledby="capacity-rescue-title"
      className="rounded-xl border border-[var(--booking-border)] bg-[var(--booking-bg-input)] p-4"
    >
      <h3
        id="capacity-rescue-title"
        className="text-sm font-semibold text-[var(--booking-text)]"
      >
        {t.capacityRescueTitle}
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-[var(--booking-text-muted)]">
        {t.capacityRescueDescription}
      </p>
      <label
        htmlFor={emailInputId}
        className="mt-3 block text-sm font-medium text-[var(--booking-text)]"
      >
        {t.waitlistEmailLabel}
      </label>
      <input
        id={emailInputId}
        type="email"
        inputMode="email"
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder={t.otpEmailPlaceholder}
        className="nq-booking-field mt-2"
      />
      {error ? (
        <p className="mt-2 text-xs text-nq-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        disabled={!emailValid || submitting}
        onClick={() => onSubmit(email.trim())}
        className="mt-3 min-h-11 w-full border border-[var(--booking-border)] bg-transparent text-[var(--booking-text)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitting ? t.capacityRescueSubmitting : t.capacityRescueJoinCta}
      </Button>
    </section>
  );
}
