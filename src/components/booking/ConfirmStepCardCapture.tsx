"use client";

import * as ErrorReporter from "@/shared/observability/errorReporter";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/Button";
import { loadSquareWebPaymentsSdk, mountSquareCardForm, safeSquareTokenizationStatus, type SquareCard } from "@/shared/booking/squareCardForm";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { CardWebviewFallback } from "@/components/booking/CardWebviewFallback";
import { isInAppBrowser } from "@/shared/lib/inAppBrowser";
import { useInAppBrowser } from "@/shared/lib/useInAppBrowser";
import { buildSquareStoreBillingContact } from "@/shared/noshow/squareStoreBillingContact";

export type ConfirmStepCardHandle = {
  /** Tokenize the entered card AND run Square buyer verification (SCA/AVS/CVV).
   *  Square's current SDK embeds verification into the source token. The
   *  optional legacy verificationToken property remains for caller
   *  compatibility but is no longer produced. Any verification failure returns
   *  null, so an unverified card never gets saved. */
  tokenize: () => Promise<{ token: string; verificationToken?: string } | null>;
  /** Clears any stale error shown below the card form. The parent calls this
   *  at the start of each confirm attempt so the user sees a clean slate. */
  clearError: () => void;
};

type Props = {
  applicationId: string;
  locationId: string;
  environment: "production" | "sandbox";
  feeLabel: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  t: BookingMessages;
};

/**
 * Square card-entry rendered INSIDE the confirm step (Option A). Unlike the
 * post-booking capture, it does NOT save — it exposes tokenize() so the confirm
 * action can grab the token and save the card as part of creating the booking.
 */
export const ConfirmStepCardCapture = forwardRef<ConfirmStepCardHandle, Props>(
  function ConfirmStepCardCapture({
    applicationId,
    locationId,
    environment,
    feeLabel,
    customerName,
    customerPhone,
    customerEmail,
    t,
  }, ref) {
    const cardRef = useRef<SquareCard | null>(null);
    const formId = useId().replace(/[^A-Za-z0-9_-]/g, "");
    const [formAttempt, setFormAttempt] = useState(0);
    const [failedForm, setFailedForm] = useState<string | null>(null);
    const configId = [applicationId, locationId, environment].join("-").replace(/[^A-Za-z0-9_-]/g, "");
    const cardContainerId = `sq-confirm-card-${formId}-${formAttempt}-${configId}`;
    const formLoadFailed = failedForm === cardContainerId;
    const [error, setError] = useState<string | null>(null);
    const [readyFor, setReadyFor] = useState<string | null>(null);
    const formKey = [cardContainerId, applicationId, locationId, environment].join(":");
    const ready = readyFor === formKey;
    const inAppBrowser = useInAppBrowser();

    useEffect(() => {
      cardRef.current = null;
      const cancel = mountSquareCardForm({
        loadSdk: () => loadSquareWebPaymentsSdk(environment),
        applicationId, locationId, selector: `#${cardContainerId}`,
        onReady(card) {
          try {
            (card as unknown as { addEventListener: (e: string, h: () => void) => void })
              .addEventListener("errorChanged", () => setError(null));
          } catch { /* Older SDK versions might not expose this event. */ }
          cardRef.current = card;
          setReadyFor(formKey);
          setFailedForm(null);
          setError(null);
        },
        onError(failure) {
          setFailedForm(cardContainerId);
          ErrorReporter.captureMessage("square_card_form_load_failed", {
            level: "warning",
            tags: { surface: "booking_confirm", payment_step: failure.stage,
              square_error_kind: failure.code, environment,
              secure_context: String(window.isSecureContext) },
          });
        },
      });
      return () => { cardRef.current = null; cancel(); };
    }, [applicationId, locationId, environment, cardContainerId, formKey]);

    useImperativeHandle(ref, () => ({
      clearError() { setError(null); },
      async tokenize() {
        if (!cardRef.current || !ready) {
          setError(t.noShowCardLoadError);
          return null;
        }
        try {
          // Square now performs buyer verification as part of tokenization.
          // A failed or timed-out 3DS/CVV/AVS check must stop the save-card
          // flow instead of silently falling back to an unverified card.
          const res = await cardRef.current.tokenize({
            intent: "STORE",
            billingContact: buildSquareStoreBillingContact({
              name: customerName,
              phone: customerPhone,
              email: customerEmail,
            }),
            customerInitiated: true,
            sellerKeyedIn: false,
          });
          if (res.status !== "OK" || !res.token) {
            ErrorReporter.captureMessage("square_card_tokenization_failed", {
              level: "warning",
              tags: {
                surface: "booking_confirm",
                square_status: safeSquareTokenizationStatus(res.status),
                in_app_browser: String(isInAppBrowser()),
              },
            });
            setError(
              t.cardVerificationError ??
                "Card verification could not be completed. Please try again or open this page in Safari or Chrome.",
            );
            return null;
          }
          setError(null);
          return { token: res.token };
        } catch {
          ErrorReporter.captureException(
            new Error("square_card_tokenization_threw"),
            {
              tags: {
                surface: "booking_confirm",
                payment_step: "card_tokenize",
                in_app_browser: String(isInAppBrowser()),
              },
            },
          );
          setError(
            t.cardVerificationError ??
              "Card verification timed out. Please try again or open this page in Safari or Chrome.",
          );
          return null;
        }
      },
    }));

    return (
      <div className="mt-4 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4">
        <p className="text-sm font-semibold text-[var(--booking-text)]">
          {t.noShowCardTitle ?? "No-show card protection"}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--booking-text-muted)]">
          {(t.noShowCardDesc ??
            "Save a card to activate no-show protection. Under the policy, a {fee} fee may apply if you miss your appointment. No charge today.").replace(
            "{fee}",
            feeLabel,
          )}
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
          data-testid="confirm-step-card"
        />
        {!ready && !formLoadFailed && !error ? (
          <p className="mt-2 text-xs text-[var(--booking-text-muted)]">
            {t.noShowCardLoading}
          </p>
        ) : null}
        {formLoadFailed || error ? (
          <p className="mt-2 text-xs text-nq-error" role="alert" data-testid="confirm-step-card-error">
            {formLoadFailed ? t.noShowCardLoadError : error}
          </p>
        ) : null}
        {formLoadFailed ? (
          <Button size="lg" fullWidth className="mt-3" onClick={() => {
            setError(null); setReadyFor(null); setFailedForm(null);
            setFormAttempt(attempt => attempt + 1);
          }}>{t.noShowCardReload}</Button>
        ) : null}
      </div>
    );
  },
);
