"use client";

import { useMemo, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import type { BookingMessages } from "@/shared/i18n/booking/en";

/**
 * Stripe one-tap no-show card capture. The Payment Element renders Apple Pay /
 * Google Pay buttons automatically when available (Face ID, no typing) plus a
 * card field fallback. confirmSetup saves the card (SetupIntent, NO charge); the
 * resulting PaymentMethod is sent to the provider-agnostic save route.
 */
function StripeCardForm({
  bookingId,
  feeLabel,
  t,
  onSaved,
}: {
  bookingId: string;
  feeLabel: string;
  t: BookingMessages;
  onSaved: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [consented, setConsented] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onSave() {
    if (!stripe || !elements || !consented || status === "saving") return;
    setStatus("saving");
    setErrorMsg(null);
    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
    });
    if (error) {
      setStatus("error");
      setErrorMsg(error.message ?? t.noShowCardError ?? "Could not save the card.");
      return;
    }
    const pmId =
      typeof setupIntent?.payment_method === "string"
        ? setupIntent.payment_method
        : setupIntent?.payment_method?.id;
    if (!pmId) {
      setStatus("error");
      setErrorMsg(t.noShowCardError ?? "Could not save the card.");
      return;
    }
    try {
      const res = await fetch("/api/booking/square-save-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId, sourceId: pmId, consent: true }),
      });
      const j = (await res.json()) as { ok?: boolean };
      if (j.ok) {
        onSaved();
      } else {
        setStatus("error");
        setErrorMsg(t.noShowCardError ?? "Could not save the card.");
      }
    } catch {
      setStatus("error");
      setErrorMsg(t.noShowCardError ?? "Could not save the card.");
    }
  }

  return (
    <div className="mt-5 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4 sm:p-5">
      <p className="text-sm font-semibold text-[var(--booking-text)]">
        {t.noShowCardTitle ?? "Secure your appointment"}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-[var(--booking-text-muted)]">
        {(t.noShowCardDesc ??
          "Add a card to hold your spot. You're only charged {fee} if you don't show up — nothing now.").replace(
          "{fee}",
          feeLabel,
        )}
      </p>
      <div className="mt-3">
        <PaymentElement options={{ layout: "tabs" }} />
      </div>
      {errorMsg ? (
        <p className="mt-2 text-xs text-nq-error" role="alert">
          {errorMsg}
        </p>
      ) : null}
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-[var(--booking-text-muted)]">
        <input
          type="checkbox"
          checked={consented}
          onChange={(e) => setConsented(e.target.checked)}
          data-testid="noshow-consent"
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--salon-primary)]"
        />
        <span>
          {(t.noShowConsent ??
            "I agree to the no-show policy and authorize this salon to charge {fee} to this card only if I don't show up.").replace(
            "{fee}",
            feeLabel,
          )}
        </span>
      </label>
      <button
        type="button"
        onClick={onSave}
        disabled={status === "saving" || !consented || !stripe}
        data-testid="noshow-card-save"
        className="mt-3 h-11 w-full rounded-xl bg-[var(--salon-primary)] text-sm font-semibold text-white disabled:opacity-50"
      >
        {status === "saving"
          ? (t.noShowCardSaving ?? "Saving…")
          : (t.noShowCardSave ?? "Save card")}
      </button>
    </div>
  );
}

export function NoShowCardCaptureStripe({
  bookingId,
  clientSecret,
  publishableKey,
  feeLabel,
  t,
}: {
  bookingId: string;
  clientSecret: string;
  publishableKey: string;
  feeLabel: string;
  t: BookingMessages;
}) {
  const stripePromise = useMemo(
    () => (publishableKey ? loadStripe(publishableKey) : null),
    [publishableKey],
  );
  const [saved, setSaved] = useState(false);

  if (saved) {
    return (
      <div
        className="mt-5 rounded-xl border border-nq-success/40 bg-nq-success/10 px-4 py-3 text-sm text-nq-success"
        data-testid="noshow-card-saved"
      >
        ✓{" "}
        {(t.noShowCardSaved ??
          "Card saved — you're only charged {fee} if you no-show.").replace(
          "{fee}",
          feeLabel,
        )}
      </div>
    );
  }
  if (!stripePromise) return null;

  return (
    <Elements stripe={stripePromise} options={{ clientSecret }}>
      <StripeCardForm
        bookingId={bookingId}
        feeLabel={feeLabel}
        t={t}
        onSaved={() => setSaved(true)}
      />
    </Elements>
  );
}
