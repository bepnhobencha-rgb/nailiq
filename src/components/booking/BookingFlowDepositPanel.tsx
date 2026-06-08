"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { formatCurrency, type Currency } from "@/shared/lib/currencyFormat";

type IntentResponse =
  | { required: false }
  | {
      required: true;
      clientSecret: string;
      paymentIntentId: string;
      connectedAccountId: string;
      publishableKey: string;
      amountCents: number;
      currency: string;
    };

type Props = {
  salonId: string;
  serviceId: string;
  clientPhone: string;
  /** Localized copy (falls back to English literals when a key is absent). */
  labels?: {
    title?: string;
    subtitle?: string;
    pay?: string;
    paying?: string;
    back?: string;
    error?: string;
  };
  onPaid: (paymentIntentId: string, connectedAccountId: string) => void;
  /** No deposit actually required (or salon not connected) → continue normally. */
  onSkip: () => void;
  onBack: () => void;
};

/**
 * Deposit step — collects a card deposit charged on the SALON's connected Stripe
 * account. Mounted only when verification requires a deposit. If the server says
 * no deposit is required (or the salon isn't connected) it transparently skips.
 */
export function BookingFlowDepositPanel({
  salonId,
  serviceId,
  clientPhone,
  labels,
  onPaid,
  onSkip,
  onBack,
}: Props) {
  const [intent, setIntent] = useState<IntentResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const skipped = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/booking/deposit-intent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ salonId, serviceId, clientPhone }),
        });
        const data = (await res.json()) as IntentResponse | { error: string };
        if (cancelled) return;
        if (!res.ok || "error" in data) {
          // salon_not_connected / stripe_not_configured → behave as no-deposit so
          // booking still completes (the gate is best-effort, not a hard block).
          if (!skipped.current) {
            skipped.current = true;
            onSkip();
          }
          return;
        }
        if (data.required === false) {
          if (!skipped.current) {
            skipped.current = true;
            onSkip();
          }
          return;
        }
        setIntent(data);
      } catch {
        if (cancelled) return;
        if (!skipped.current) {
          skipped.current = true;
          onSkip();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [salonId, serviceId, clientPhone, onSkip]);

  const stripePromise = useMemo<Promise<Stripe | null> | null>(() => {
    if (!intent || intent.required !== true) return null;
    return loadStripe(intent.publishableKey, {
      stripeAccount: intent.connectedAccountId,
    });
  }, [intent]);

  if (loadError) {
    return (
      <div className="space-y-3 text-center">
        <p className="text-sm text-[var(--booking-text)]">
          {labels?.error ?? "Couldn't load payment. Please try again."}
        </p>
        <button type="button" onClick={onBack} className="text-sm underline">
          {labels?.back ?? "Back"}
        </button>
      </div>
    );
  }

  if (!intent || intent.required !== true || !stripePromise) {
    return (
      <p className="py-8 text-center text-sm text-[var(--booking-text-muted)]">
        {labels?.title ?? "Preparing secure deposit…"}
      </p>
    );
  }

  const amount =
    formatCurrency(intent.amountCents, intent.currency as Currency) ??
    `${(intent.amountCents / 100).toFixed(2)}`;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-base font-semibold text-[var(--booking-text)]">
          {labels?.title ?? "Secure your booking with a deposit"}
        </p>
        <p className="mt-1 text-sm text-[var(--booking-text-muted)]">
          {(labels?.subtitle ?? "A {amount} deposit is required and goes toward your service.").replace(
            "{amount}",
            amount,
          )}
        </p>
      </div>
      <Elements
        stripe={stripePromise}
        options={{ clientSecret: intent.clientSecret, appearance: { theme: "night" } }}
      >
        <DepositForm
          amountLabel={amount}
          paymentIntentId={intent.paymentIntentId}
          connectedAccountId={intent.connectedAccountId}
          labels={labels}
          onPaid={onPaid}
          onBack={onBack}
          onFatal={() => setLoadError(true)}
        />
      </Elements>
    </div>
  );
}

function DepositForm({
  amountLabel,
  paymentIntentId,
  connectedAccountId,
  labels,
  onPaid,
  onBack,
}: {
  amountLabel: string;
  paymentIntentId: string;
  connectedAccountId: string;
  labels?: Props["labels"];
  onPaid: (paymentIntentId: string, connectedAccountId: string) => void;
  onBack: () => void;
  onFatal: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function pay() {
    if (!stripe || !elements) return;
    setBusy(true);
    setErr(null);
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
    });
    if (error) {
      setErr(error.message ?? (labels?.error ?? "Payment failed. Please try again."));
      setBusy(false);
      return;
    }
    if (paymentIntent && paymentIntent.status === "succeeded") {
      onPaid(paymentIntentId, connectedAccountId);
      return;
    }
    setErr(labels?.error ?? "Payment not completed. Please try again.");
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <PaymentElement />
      {err ? <p className="text-sm text-nq-error">{err}</p> : null}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="text-sm text-[var(--booking-text-muted)] disabled:opacity-50"
        >
          {labels?.back ?? "Back"}
        </button>
        <button
          type="button"
          onClick={() => void pay()}
          disabled={busy || !stripe}
          className="ml-auto rounded-full bg-[var(--booking-accent)] px-6 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? (labels?.paying ?? "Processing…") : `${labels?.pay ?? "Pay deposit"} · ${amountLabel}`}
        </button>
      </div>
    </div>
  );
}
