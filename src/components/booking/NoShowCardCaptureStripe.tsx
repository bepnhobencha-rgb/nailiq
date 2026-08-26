"use client";

import { useMemo, useState } from "react";
// The default Stripe entrypoint injects Stripe.js as soon as this module is
// evaluated. Use the pure entrypoint so a public booking page does not contact
// Stripe until this card-capture component actually has an approved intent.
import { loadStripe } from "@stripe/stripe-js/pure";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import type { SavedNoShowCard } from "@/shared/noshow/resolveSavedNoShowCard";
import { reuseNoShowCardAction } from "@/shared/noshow/saveNoShowCardAction";
import { stableBookingManagementRequestId } from "@/shared/booking/bookingManagementRequestId";

/**
 * Saved-card reuse tile for the Stripe path. The reuse action is
 * provider-agnostic (re-derives the card from the OTP-verified phone
 * server-side), so we can offer one-tap reuse here too without touching Stripe
 * Elements. Mirrors the Square reuse tile in NoShowCardCapture.tsx.
 */
function StripeSavedCardReuseTile({
  bookingId,
  otpSessionId,
  savedCard,
  feeLabel,
  t,
  onUseDifferent,
  onSaved,
}: {
  bookingId: string;
  otpSessionId: string;
  savedCard: { hasSavedCard: true; brand: string; last4: string };
  feeLabel: string;
  t: BookingMessages;
  onUseDifferent: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onReuse() {
    if (saving) return;
    setSaving(true);
    setErrorMsg(null);
    try {
      const r = await reuseNoShowCardAction({ bookingId, otpSessionId, consent: true });
      if (r.ok) {
        onSaved();
      } else {
        setErrorMsg(t.noShowCardError ?? "Could not use your saved card.");
      }
    } catch {
      setErrorMsg(t.noShowCardError ?? "Could not use your saved card.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="mt-5 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4 sm:p-5"
      data-testid="saved-card-reuse"
    >
      <p className="text-sm font-semibold text-[var(--booking-text)]">
        {t.noShowCardTitle ?? "Secure your appointment"}
      </p>
      <div className="mt-3 flex items-center gap-3 rounded-lg border border-[var(--booking-border)] bg-[var(--booking-bg-input)] px-3 py-3">
        <span aria-hidden className="text-base">💳</span>
        <span className="text-sm font-medium text-[var(--booking-text)]">
          {savedCard.brand || "Card"} •••• {savedCard.last4}
        </span>
        <span className="ml-auto rounded-full bg-[var(--salon-primary)]/15 px-2 py-0.5 text-[11px] font-semibold text-[var(--salon-primary)]">
          {t.noShowSavedCardOnFile ?? "On file"}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-[var(--booking-text-muted)]">
        {(t.noShowSavedCardDesc ??
          "We'll use your saved card. You're only charged {fee} if you don't show up — nothing now.").replace(
          "{fee}",
          feeLabel,
        )}
      </p>
      {errorMsg ? (
        <p className="mt-2 text-xs text-nq-error" role="alert">
          {errorMsg}
        </p>
      ) : null}
      <button
        type="button"
        onClick={onReuse}
        disabled={saving}
        data-testid="noshow-card-reuse-confirm"
        className="mt-3 h-11 w-full rounded-xl bg-[var(--salon-primary)] text-sm font-semibold text-white disabled:opacity-50"
      >
        {saving ? (t.noShowCardSaving ?? "Saving…") : (t.noShowCardSave ?? "Use saved card")}
      </button>
      <button
        type="button"
        data-testid="use-different-card"
        onClick={onUseDifferent}
        className="mt-2 text-xs font-semibold text-[var(--salon-primary)] underline"
      >
        {t.noShowUseDifferentCard ?? "Use a different card"}
      </button>
    </div>
  );
}

/**
 * Stripe one-tap no-show card capture. The Payment Element renders Apple Pay /
 * Google Pay buttons automatically when available (Face ID, no typing) plus a
 * card field fallback. confirmSetup saves the card (SetupIntent, NO charge); the
 * resulting PaymentMethod is sent to the provider-agnostic save route.
 */
function StripeCardForm({
  managementToken,
  feeLabel,
  t,
  onSaved,
}: {
  managementToken: string;
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
        body: JSON.stringify({
          token: managementToken,
          requestId: await stableBookingManagementRequestId({
            action: "card_manage",
            token: managementToken,
            material: "stripe_save_card:v1",
          }),
          provider: "stripe",
          sourceId: pmId,
          consent: true,
        }),
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
  managementToken,
  clientSecret,
  publishableKey,
  feeLabel,
  t,
  savedCard,
  otpSessionId,
}: {
  bookingId: string;
  managementToken: string;
  clientSecret: string;
  publishableKey: string;
  feeLabel: string;
  t: BookingMessages;
  /** Returning OTP-verified customer's card on file — enables one-tap reuse. */
  savedCard?: SavedNoShowCard | null;
  /** OTP session id — required for the server-authoritative reuse action. */
  otpSessionId?: string | null;
}) {
  const stripePromise = useMemo(
    () => (publishableKey ? loadStripe(publishableKey) : null),
    [publishableKey],
  );
  const [saved, setSaved] = useState(false);
  const [useDifferentCard, setUseDifferentCard] = useState(false);

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

  // Returning customer with a card on file → one-tap reuse (provider-agnostic
  // action), unless they chose to enter a different card.
  if (savedCard?.hasSavedCard && otpSessionId && !useDifferentCard) {
    return (
      <StripeSavedCardReuseTile
        bookingId={bookingId}
        otpSessionId={otpSessionId}
        savedCard={savedCard}
        feeLabel={feeLabel}
        t={t}
        onUseDifferent={() => setUseDifferentCard(true)}
        onSaved={() => setSaved(true)}
      />
    );
  }

  if (!stripePromise) return null;

  return (
    <Elements stripe={stripePromise} options={{ clientSecret }}>
      <StripeCardForm
        managementToken={managementToken}
        feeLabel={feeLabel}
        t={t}
        onSaved={() => setSaved(true)}
      />
    </Elements>
  );
}
