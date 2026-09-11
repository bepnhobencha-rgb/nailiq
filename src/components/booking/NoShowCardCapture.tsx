"use client";

import { Button } from "@/components/ui/Button";
import { CardProtectionRecovery } from "./CardProtectionRecovery";
import * as ErrorReporter from "@/shared/observability/errorReporter";
import { useEffect, useId, useRef, useState } from "react";
import { loadSquareWebPaymentsSdk, mountSquareCardForm, safeSquareTokenizationStatus, type SquareCard } from "@/shared/booking/squareCardForm";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { NoShowCardCaptureStripe } from "./NoShowCardCaptureStripe";
import type { SavedNoShowCard } from "@/shared/noshow/resolveSavedNoShowCard";
import { reuseNoShowCardAction } from "@/shared/noshow/saveNoShowCardAction";
import { CardWebviewFallback } from "./CardWebviewFallback";
import { isInAppBrowser } from "@/shared/lib/inAppBrowser";
import { useInAppBrowser } from "@/shared/lib/useInAppBrowser";
import {
  pendingBookingManagementRequest,
  stableBookingManagementRequestId,
} from "@/shared/booking/bookingManagementRequestId";

type CaptureProps = {
  onSettled?: () => Promise<void>;
  bookingId: string;
  /** Server-minted, action-scoped proof for this exact booking. */
  managementToken: string;
  /** Formats cents → display string (e.g. "$20.00") in the salon currency. */
  currencyFormat: (cents: number) => string;
  t: BookingMessages;
  /** Returning OTP-verified customer's card on file (if any) — enables one-tap
   *  reuse instead of fresh entry. Optional: callers that don't pass it (e.g.
   *  the save-card page, BookingFlowDonePanel) get the fresh-entry form. */
  savedCard?: SavedNoShowCard | null;
  /** OTP session id — required for the server-authoritative reuse action. */
  otpSessionId?: string | null;
};

/**
 * Dispatcher: a Stripe-provider salon shows the one-tap Payment Element (Apple/
 * Google Pay); a Square salon shows the card-entry form below. Renders nothing
 * until it knows, and nothing when no card is required for this booking.
 */
export function NoShowCardCapture(props: CaptureProps) {
  return <CardProtectionRecovery key={props.managementToken} token={props.managementToken} t={props.t}
    Capture={ProviderCardCapture} captureProps={props} />;
}

function ProviderCardCapture(props: CaptureProps) {
  const [stripeCfg, setStripeCfg] = useState<{
    required: boolean;
    clientSecret?: string;
    publishableKey?: string;
    feeCents?: number;
    finalizeToken?: string;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const pending = await pendingBookingManagementRequest({
          action: "card_manage",
          token: props.managementToken,
        });
        if (pending?.material.startsWith("stripe_setup_intent:v1:")) {
          const feeCents = Number(pending.material.split(":").at(-1));
          const response = await fetch("/api/booking/stripe-setup-intent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: props.managementToken, requestId: pending.requestId }),
          });
          const value = await response.json();
          if (alive) setStripeCfg({ ...value, feeCents: Number.isSafeInteger(feeCents) ? feeCents : 0 });
          return;
        }
        const configResponse = await fetch(
          `/api/booking/square-noshow-config?token=${encodeURIComponent(props.managementToken)}`,
        );
        const config = await configResponse.json() as { required?: boolean; provider?: string; feeCents?: number };
        if (!configResponse.ok || config.required !== true || config.provider !== "stripe") {
          if (alive) setStripeCfg({ required: false });
          return;
        }
        const requestId = await stableBookingManagementRequestId({
          action: "card_manage",
          token: props.managementToken,
          material: `stripe_setup_intent:v1:${config.feeCents ?? 0}`,
        });
        const response = await fetch("/api/booking/stripe-setup-intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: props.managementToken, requestId }),
        });
        const value = await response.json();
        if (alive) setStripeCfg({ ...value, feeCents: config.feeCents });
      } catch {
        if (alive) setStripeCfg({ required: false });
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.managementToken]);

  if (stripeCfg === null) return <p role="status">{props.t.cardProtection.checking}</p>; // still deciding which provider
  if (stripeCfg.required && stripeCfg.clientSecret && stripeCfg.publishableKey && stripeCfg.finalizeToken) {
    return (
      <NoShowCardCaptureStripe
        bookingId={props.bookingId}
        managementToken={stripeCfg.finalizeToken}
        clientSecret={stripeCfg.clientSecret}
        publishableKey={stripeCfg.publishableKey}
        feeLabel={props.currencyFormat(stripeCfg.feeCents ?? 0)}
        t={props.t}
        savedCard={props.savedCard}
        otpSessionId={props.otpSessionId}
        onSettled={props.onSettled}
      />
    );
  }
  return <SquareCardCapture {...props} />;
}

type Cfg = {
  required: boolean;
  feeCents?: number;
  applicationId?: string;
  locationId?: string;
  environment?: "production" | "sandbox";
};

/**
 * Post-booking no-show protection (Square card-on-file). Fetches its own config;
 * renders nothing unless the booking is risk-gated and Square is configured.
 * The card is saved (not charged); the salon bills the fee only on a no-show.
 */
/**
 * Reusable saved-card tile (mirrors BookingFlowConfirmPanel's `saved-card-reuse`
 * block). One-tap reuse of a returning customer's card on file: shows brand ••••
 * last4 + an "On file" pill, a primary "Use saved card" button that calls the
 * server-authoritative reuse action (no card id from the client), and a "Use a
 * different card" link to fall back to fresh entry.
 */
function SavedCardReuseTile({
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

/** Square card-entry capture (Web Payments SDK). Used when the salon's provider
 *  is Square. The Stripe path (one-tap wallets) is handled by the dispatcher. */
function SquareCardCapture({ onSettled, bookingId, managementToken, currencyFormat, t, savedCard, otpSessionId }: CaptureProps) {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);
  // When a returning customer has a card on file we show the reuse tile first;
  // this flips to true if they tap "Use a different card".
  const [useDifferentCard, setUseDifferentCard] = useState(false);
  const inAppBrowser = useInAppBrowser();
  const cardRef = useRef<SquareCard | null>(null);
  const formId = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const [formAttempt, setFormAttempt] = useState(0);
  const [formResult, setFormResult] = useState<{ key: string; state: "ready" | "error" } | null>(null);
  const applicationId = cfg?.applicationId ?? "";
  const locationId = cfg?.locationId ?? "";
  const environment = cfg?.environment ?? "production";
  const required = cfg?.required === true;
  const configId = [applicationId, locationId, environment].join("-").replace(/[^A-Za-z0-9_-]/g, "");
  const cardContainerId = `sq-noshow-card-${formId}-${formAttempt}-${configId}`;
  const formKey = cardContainerId;
  const formState = formResult?.key === formKey ? formResult.state : "loading";

  const showReuseTile =
    !!(savedCard?.hasSavedCard && otpSessionId) && !useDifferentCard && status !== "saved";

  // 1. Decide whether to show + get the SDK params.
  useEffect(() => {
    let alive = true;
    fetch(`/api/booking/square-noshow-config?token=${encodeURIComponent(managementToken)}`)
      .then((r) => r.json())
      .then((c: Cfg) => {
        if (alive) setCfg(c);
      })
      .catch(() => {
        if (alive) setCfg({ required: false });
      });
    return () => {
      alive = false;
    };
  }, [managementToken]);

  // Each attempt owns its card and DOM container. Cleanup cannot publish a
  // stale instance or remove the iframe belonging to a newer attempt.
  useEffect(() => {
    if (showReuseTile || !required || !applicationId || !locationId) return;
    cardRef.current = null;
    const cancel = mountSquareCardForm({
      loadSdk: () => loadSquareWebPaymentsSdk(environment),
      applicationId,
      locationId,
      selector: `#${cardContainerId}`,
      onReady(card) {
        cardRef.current = card;
        setFormResult({ key: formKey, state: "ready" });
        setErrorMsg(null);
      },
      onError(failure) {
        setFormResult({ key: formKey, state: "error" });
        ErrorReporter.captureMessage("square_card_form_load_failed", {
          level: "warning",
          tags: { surface: "booking_save_card", payment_step: failure.stage,
            square_error_kind: failure.code, environment,
            secure_context: String(window.isSecureContext) },
        });
      },
    });
    return () => { cardRef.current = null; cancel(); };
  }, [required, applicationId, locationId, environment, cardContainerId, formKey, showReuseTile]);

  async function onSave() {
    if (!cardRef.current || formState !== "ready" || status === "saving" || !consented) return;
    setStatus("saving");
    setErrorMsg(null);
    let dispatched = false;
    try {
      const contextResponse = await fetch(`/api/booking/save-card-context?token=${encodeURIComponent(managementToken)}`, { cache: "no-store" });
      const context = await contextResponse.json();
      if (!contextResponse.ok || context.canRetry !== true) { await onSettled?.(); return; }
      // Square's current Web Payments flow performs buyer verification during
      // tokenization. Never downgrade to an unverified card when 3DS, CVV, or
      // AVS verification fails or times out.
      const result = await cardRef.current.tokenize({
        intent: "STORE",
        // Square requires this object even when this secure recovery page
        // intentionally has no customer contact fields to send.
        billingContact: {},
        customerInitiated: true,
        sellerKeyedIn: false,
      });
      if (result.status !== "OK" || !result.token) {
        ErrorReporter.captureMessage("square_card_tokenization_failed", {
          level: "warning",
          tags: {
            surface: "booking_save_card",
            square_status: safeSquareTokenizationStatus(result.status),
            in_app_browser: String(isInAppBrowser()),
          },
        });
        setStatus("error");
        setErrorMsg(
          t.cardVerificationError ??
            "Card verification could not be completed. Please try again or open this page in Safari or Chrome.",
        );
        return;
      }
      dispatched = true;
      const res = await fetch("/api/booking/square-save-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: managementToken,
          requestId: await stableBookingManagementRequestId({
            action: "card_manage",
            token: managementToken,
            material: "square_save_card:v1",
          }),
          provider: "square",
          sourceId: result.token,
          consent: true,
        }),
      });
      const j = (await res.json()) as { ok?: boolean };
      if (res.ok && j.ok) {
        setStatus("saved");
      } else {
        setStatus("error");
        setErrorMsg(t.noShowCardError ?? "Could not save the card.");
      }
      await onSettled?.();
    } catch {
      ErrorReporter.captureException(
        new Error(dispatched ? "square_card_delivery_uncertain" : "square_card_tokenization_threw"),
        {
          tags: {
            surface: "booking_save_card",
            payment_step: dispatched ? "card_save" : "card_tokenize",
            in_app_browser: String(isInAppBrowser()),
          },
        },
      );
      if (dispatched) await onSettled?.();
      setStatus("error");
      setErrorMsg(
        t.cardVerificationError ??
          "Card verification timed out. Please try again or open this page in Safari or Chrome.",
      );
    }
  }

  if (!cfg) return <p role="status" className="mt-3 text-sm">{t.cardProtection.checking}</p>;
  if (!cfg.required) return <div className="mt-3">
    <p role="alert" className="text-sm text-[var(--booking-text-muted)]">{t.cardProtection.unavailable}</p>
    <Button size="lg" fullWidth className="mt-3 bg-[var(--cta-bg)] text-[var(--cta-text)]" onClick={() => void onSettled?.()}>{t.cardProtection.retry}</Button>
  </div>;

  const feeLabel = currencyFormat(cfg.feeCents ?? 0);

  if (status === "saved") return <p role="status" className="mt-3 text-sm">{t.cardProtection.checking}</p>;

  // Returning customer with a card on file → one-tap reuse (no re-entry),
  // unless they explicitly chose to enter a different card.
  if (showReuseTile && savedCard?.hasSavedCard && otpSessionId) {
    return (
      <SavedCardReuseTile
        bookingId={bookingId}
        otpSessionId={otpSessionId}
        savedCard={savedCard}
        feeLabel={feeLabel}
        t={t}
        onUseDifferent={() => setUseDifferentCard(true)}
        onSaved={() => { void onSettled?.(); }}
      />
    );
  }

  return (
    <div className="mt-5 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4 sm:p-5">
      <p className="text-sm font-semibold text-[var(--booking-text)]">
        {t.noShowCardTitle ?? "No-show card protection"}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-[var(--booking-text-muted)]">
        {(t.noShowCardDesc ?? "Save a card to activate no-show protection. Under the policy, a {fee} fee may apply if you miss your appointment. No charge today.").replace("{fee}", feeLabel)}
      </p>
      {inAppBrowser ? (
        <CardWebviewFallback
          forceVisible
          hint={t.cardWebviewHint ?? "Card verification may not finish in this app's browser. Open this page in Safari or Chrome, or copy the link below."}
          copyLabel={t.cardWebviewCopy ?? "Copy booking link"}
          copiedLabel={t.cardWebviewCopied ?? "Link copied"}
          openChromeLabel={t.cardWebviewOpenChrome ?? "Open in Chrome"}
        />
      ) : null}
      <div
        key={cardContainerId}
        id={cardContainerId}
        className="mt-3 rounded-lg border border-[var(--booking-border)] bg-white p-2"
      />
      {formState === "error" || errorMsg ? (
        <p className="mt-2 text-xs text-nq-error" role="alert">
          {formState === "error" ? t.noShowCardLoadError : errorMsg}
        </p>
      ) : null}
      {formState === "loading" ? <p role="status" className="mt-2 text-xs text-[var(--booking-text-muted)]">{t.noShowCardLoading}</p> : null}
      {formState === "error" ? (
        <Button size="lg" fullWidth className="mt-3" onClick={() => {
          setErrorMsg(null); setFormResult(null); setStatus("idle");
          setFormAttempt(attempt => attempt + 1);
        }}>{t.noShowCardReload}</Button>
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
        disabled={formState !== "ready" || status === "saving" || !consented}
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
