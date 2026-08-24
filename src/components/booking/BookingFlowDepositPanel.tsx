"use client";

import { useEffect, useMemo, useRef, useState } from "react";
// Keep provider code off the initial public booking page. The pure entrypoint
// loads Stripe.js only after the server has returned a Stripe deposit intent.
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { formatCurrency, type Currency } from "@/shared/lib/currencyFormat";
import type { PublicBookingPricingQuote } from "@/shared/booking/publicBookingPricing";
import { stablePublicDepositReplayIdentity } from "@/shared/payments/publicDepositReplayIdentity";
import type { PaidPublicDeposit } from "@/shared/payments/publicDepositTypes";
import {
  isPaymentReconciliationCode,
  publicDepositFailureMessage,
} from "@/shared/payments/paymentOutagePresentation";

type IntentResponse =
  | { required: false }
  | {
      required: true;
      paymentCompleted: true;
      operationId: string;
      paymentRequestId: string;
      materialFingerprint: string;
    }
  | {
      required: true;
      paymentCompleted?: false;
      provider: "stripe";
      clientSecret: string;
      paymentIntentId: string;
      connectedAccountId: string;
      publishableKey: string;
      amountCents: number;
      currency: string;
      operationId: string;
      paymentRequestId: string;
      materialFingerprint: string;
      finalizeToken: string;
    }
  | {
      required: true;
      paymentCompleted?: false;
      provider: "square";
      squareApplicationId: string;
      squareLocationId: string;
      squareEnvironment: "production" | "sandbox";
      amountCents: number;
      currency: string;
      operationId: string;
      paymentRequestId: string;
      materialFingerprint: string;
      squareCapabilityToken: string;
    };

type Props = {
  salonId: string;
  pricingQuote: PublicBookingPricingQuote;
  bookingRequestId: string;
  clientPhone: string;
  clientEmail: string | null;
  otpSessionId: string | null;
  /** Localized copy (falls back to English literals when a key is absent). */
  labels?: {
    title?: string;
    subtitle?: string;
    pay?: string;
    paying?: string;
    back?: string;
    error?: string;
    pending?: string;
  };
  onPaid: (deposit: PaidPublicDeposit) => void;
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
  pricingQuote,
  bookingRequestId,
  clientPhone,
  clientEmail,
  otpSessionId,
  labels,
  onPaid,
  onSkip,
  onBack,
}: Props) {
  const [intent, setIntent] = useState<IntentResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const skipped = useRef(false);
  const canonicalRequest = useMemo(() => ({
    salonId,
    serviceId: pricingQuote.serviceId,
    staffId: pricingQuote.resolvedStaffId,
    startTimeUtc: pricingQuote.startTimeUtc,
    endTimeUtc: pricingQuote.endTimeUtc,
    addonServiceIds: pricingQuote.addonLines.map((line) => line.serviceId),
    comboId: pricingQuote.comboId,
    voucherId: pricingQuote.voucherId,
    clientPhone,
    clientEmail,
    applyEmailDiscount: clientEmail !== null,
    bookingRequestId,
    expectedPricingFingerprint: pricingQuote.pricingFingerprint,
    otpSessionId,
  }), [bookingRequestId, clientEmail, clientPhone, otpSessionId, pricingQuote, salonId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const materialKey = JSON.stringify({
          salonId,
          serviceId: pricingQuote.serviceId,
          staffId: pricingQuote.resolvedStaffId,
          startTimeUtc: pricingQuote.startTimeUtc,
          endTimeUtc: pricingQuote.endTimeUtc,
          addonServiceIds: pricingQuote.addonLines.map((line) => line.serviceId),
          comboId: pricingQuote.comboId,
          voucherId: pricingQuote.voucherId,
          pricingFingerprint: pricingQuote.pricingFingerprint,
          bookingRequestId,
        });
        const identity = await stablePublicDepositReplayIdentity(
          materialKey,
          bookingRequestId,
        );
        const res = await fetch("/api/booking/deposit-intent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...canonicalRequest,
            bookingRequestId: identity.bookingRequestId,
            paymentRequestId: identity.paymentRequestId,
          }),
        });
        const data = (await res.json()) as IntentResponse | { error: string };
        if (cancelled) return;
        if (!res.ok || "error" in data) {
          // The server owns the deposit decision. An unavailable boundary or
          // provider can never be reinterpreted by the browser as "no deposit".
          setLoadError("error" in data ? data.error : "deposit_unavailable");
          return;
        }
        if (data.required === false) {
          if (!skipped.current) {
            skipped.current = true;
            onSkip();
          }
          return;
        }
        if ("paymentCompleted" in data && data.paymentCompleted === true) {
          onPaid({
            operationId: data.operationId,
            paymentRequestId: data.paymentRequestId,
            materialFingerprint: data.materialFingerprint,
          });
          return;
        }
        setIntent(data);
      } catch {
        if (cancelled) return;
        setLoadError("deposit_unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    bookingRequestId,
    canonicalRequest,
    clientEmail,
    clientPhone,
    onPaid,
    onSkip,
    otpSessionId,
    pricingQuote,
    salonId,
    loadAttempt,
  ]);

  const stripePromise = useMemo<Promise<Stripe | null> | null>(() => {
    if (
      !intent || intent.required !== true || "paymentCompleted" in intent ||
      intent.provider !== "stripe"
    ) return null;
    return loadStripe(intent.publishableKey, {
      stripeAccount: intent.connectedAccountId,
    });
  }, [intent]);

  if (loadError) {
    return (
      <div className="space-y-3 text-center">
        <p className="text-sm text-[var(--booking-text)]">
          {publicDepositFailureMessage(loadError, {
            error: labels?.error ?? "Couldn't load payment. Please try again.",
            pending: labels?.pending,
          })}
        </p>
        <div className="flex justify-center gap-4">
          <button type="button" onClick={onBack} className="text-sm underline">
            {labels?.back ?? "Back"}
          </button>
          <button
            type="button"
            onClick={() => {
              setLoadError(null);
              setLoadAttempt((value) => value + 1);
            }}
            className="text-sm underline"
          >
            Check payment status / Kiểm tra trạng thái
          </button>
        </div>
      </div>
    );
  }

  if (!intent || intent.required !== true || "paymentCompleted" in intent) {
    return (
      <p className="py-8 text-center text-sm text-[var(--booking-text-muted)]">
        {labels?.title ?? "Preparing secure deposit…"}
      </p>
    );
  }

  const amount =
    formatCurrency(intent.amountCents, intent.currency as Currency) ??
    `${(intent.amountCents / 100).toFixed(2)}`;

  if (intent.provider === "square") {
    return (
      <SquareDepositForm
        intent={intent}
        amountLabel={amount}
        labels={labels}
        onPaid={onPaid}
        onBack={onBack}
      />
    );
  }
  if (!stripePromise) return null;
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
          operationId={intent.operationId}
          paymentRequestId={intent.paymentRequestId}
          materialFingerprint={intent.materialFingerprint}
          finalizeToken={intent.finalizeToken}
          labels={labels}
          onPaid={onPaid}
          onBack={onBack}
        />
      </Elements>
    </div>
  );
}

type SquareCard = {
  attach: (selector: string) => Promise<void>;
  tokenize: (details: {
    intent: "CHARGE";
    customerInitiated: true;
    sellerKeyedIn: false;
    amount: string;
    currencyCode: string;
  }) => Promise<{ status: string; token?: string }>;
};
type SquareGlobal = {
  payments: (applicationId: string, locationId: string) => {
    card: () => Promise<SquareCard>;
  };
};

async function loadSquareSdk(environment: "production" | "sandbox"): Promise<SquareGlobal> {
  if (window.Square) return window.Square as SquareGlobal;
  const src = environment === "production"
    ? "https://web.squarecdn.com/v1/square.js"
    : "https://sandbox.web.squarecdn.com/v1/square.js";
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    const script = existing ?? document.createElement("script");
    const loaded = () => window.Square
      ? resolve(window.Square as SquareGlobal)
      : reject(new Error("square_sdk_unavailable"));
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", () => reject(new Error("square_sdk_unavailable")), { once: true });
    if (!existing) {
      script.src = src;
      script.async = true;
      document.head.appendChild(script);
    } else if (window.Square) loaded();
  });
}

function SquareDepositForm({
  intent,
  amountLabel,
  labels,
  onPaid,
  onBack,
}: {
  intent: Extract<IntentResponse, { provider: "square" }>;
  amountLabel: string;
  labels?: Props["labels"];
  onPaid: (deposit: PaidPublicDeposit) => void;
  onBack: () => void;
}) {
  const cardRef = useRef<SquareCard | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconciliationPending, setReconciliationPending] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadSquareSdk(intent.squareEnvironment).then(async (Square) => {
      const card = await Square.payments(
        intent.squareApplicationId,
        intent.squareLocationId,
      ).card();
      await card.attach("#nq-square-deposit-card");
      if (!cancelled) {
        cardRef.current = card;
        setReady(true);
      }
    }).catch(() => {
      if (!cancelled) setError(labels?.error ?? "Payment unavailable.");
    });
    return () => {
      cancelled = true;
      cardRef.current = null;
    };
  }, [intent.squareApplicationId, intent.squareEnvironment, intent.squareLocationId, labels?.error]);

  async function pay() {
    if (!cardRef.current || busy) return;
    setBusy(true);
    setError(null);
    setReconciliationPending(false);
    let failureCode: string | null = null;
    try {
      const factor = ["VND", "JPY"].includes(intent.currency) ? 1 : 100;
      const tokenized = await cardRef.current.tokenize({
        intent: "CHARGE",
        customerInitiated: true,
        sellerKeyedIn: false,
        amount: (intent.amountCents / factor).toFixed(factor === 1 ? 0 : 2),
        currencyCode: intent.currency,
      });
      if (tokenized.status !== "OK" || !tokenized.token) throw new Error("tokenize_failed");
      // Once tokenization succeeds, a lost HTTP response can hide a provider
      // acceptance. Keep the durable operation and never invite a second pay.
      failureCode = "provider_outcome_unknown";
      const response = await fetch("/api/booking/deposit-intent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: intent.operationId,
          paymentRequestId: intent.paymentRequestId,
          squareCapabilityToken: intent.squareCapabilityToken,
          squareSourceToken: tokenized.token,
        }),
      });
      const result = await response.json() as {
        required?: boolean;
        paymentCompleted?: boolean;
        operationId?: string;
        materialFingerprint?: string;
        error?: string;
      };
      if (
        !response.ok || result.required !== true || result.paymentCompleted !== true ||
        result.operationId !== intent.operationId ||
        result.materialFingerprint !== intent.materialFingerprint
      ) {
        failureCode = result.error ?? (response.status >= 500 ? "deposit_pending" : null);
        throw new Error("payment_not_completed");
      }
      onPaid({
        operationId: intent.operationId,
        paymentRequestId: intent.paymentRequestId,
        materialFingerprint: intent.materialFingerprint,
      });
    } catch {
      setReconciliationPending(isPaymentReconciliationCode(failureCode));
      setError(publicDepositFailureMessage(failureCode, labels));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-base font-semibold">{labels?.title ?? "Secure your booking with a deposit"}</p>
      <div id="nq-square-deposit-card" />
      {error ? <p className="text-sm text-nq-error">{error}</p> : null}
      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack} disabled={busy} className="text-sm underline">
          {labels?.back ?? "Back"}
        </button>
        <button
          type="button"
          onClick={() => void pay()}
          disabled={!ready || busy || reconciliationPending}
          className="ml-auto rounded-full bg-[var(--booking-accent)] px-6 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {reconciliationPending
            ? "Payment under review / Đang đối soát"
            : busy
              ? (labels?.paying ?? "Processing…")
              : `${labels?.pay ?? "Pay deposit"} · ${amountLabel}`}
        </button>
      </div>
    </div>
  );
}

function DepositForm({
  amountLabel,
  operationId,
  paymentRequestId,
  materialFingerprint,
  finalizeToken,
  labels,
  onPaid,
  onBack,
}: {
  amountLabel: string;
  operationId: string;
  paymentRequestId: string;
  materialFingerprint: string;
  finalizeToken: string;
  labels?: Props["labels"];
  onPaid: (deposit: PaidPublicDeposit) => void;
  onBack: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reconciliationPending, setReconciliationPending] = useState(false);

  async function pay() {
    if (!stripe || !elements) return;
    setBusy(true);
    setErr(null);
    setReconciliationPending(false);
    let paymentIntent: { status: string } | undefined;
    try {
      const confirmed = await stripe.confirmPayment({
        elements,
        redirect: "if_required",
      });
      if (confirmed.error) {
        setErr(confirmed.error.message ?? (labels?.error ?? "Payment failed. Please try again."));
        setBusy(false);
        return;
      }
      paymentIntent = confirmed.paymentIntent;
    } catch {
      setReconciliationPending(true);
      setErr(publicDepositFailureMessage("provider_outcome_unknown", labels));
      setBusy(false);
      return;
    }
    if (paymentIntent && paymentIntent.status === "succeeded") {
      let failureCode: string | null = null;
      try {
        const finalized = await fetch("/api/booking/deposit-finalize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operationId, paymentRequestId, finalizeToken }),
        });
        const result = await finalized.json() as { ok?: boolean; code?: string };
        if (finalized.ok && result.ok === true) {
          onPaid({ operationId, paymentRequestId, materialFingerprint });
          return;
        }
        failureCode = result.code ?? (finalized.status >= 500 ? "provider_outcome_unknown" : null);
      } catch {
        // The DB ledger owns an ambiguous provider result; the same operation
        // and request are retained so Retry can reconcile without a new charge.
        failureCode = "completion_write_uncertain";
      }
      setReconciliationPending(isPaymentReconciliationCode(failureCode));
      setErr(publicDepositFailureMessage(failureCode, labels));
      setBusy(false);
      return;
    }
    const status = paymentIntent?.status;
    setReconciliationPending(isPaymentReconciliationCode(status));
    setErr(publicDepositFailureMessage(status, labels));
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
          disabled={busy || !stripe || reconciliationPending}
          className="ml-auto rounded-full bg-[var(--booking-accent)] px-6 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {reconciliationPending
            ? "Payment under review / Đang đối soát"
            : busy
              ? (labels?.paying ?? "Processing…")
              : `${labels?.pay ?? "Pay deposit"} · ${amountLabel}`}
        </button>
      </div>
    </div>
  );
}
