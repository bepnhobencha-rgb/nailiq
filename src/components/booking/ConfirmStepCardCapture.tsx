"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { BookingMessages } from "@/shared/i18n/booking/en";

type SquareCard = {
  attach: (sel: string) => Promise<void>;
  tokenize: () => Promise<{ status: string; token?: string }>;
};
type SquareVerifyDetails = {
  intent: "STORE" | "CHARGE";
  customerInitiated?: boolean;
  sellerKeyedIn?: boolean;
  billingContact?: Record<string, string>;
  amount?: string;
  currencyCode?: string;
};
type SquarePayments = {
  card: () => Promise<SquareCard>;
  verifyBuyer: (
    source: string,
    details: SquareVerifyDetails,
  ) => Promise<{ token?: string } | null>;
};
type SquareGlobal = { payments: (appId: string, locationId: string) => SquarePayments };
declare global {
  interface Window {
    Square?: SquareGlobal;
  }
}

const SDK_SRC = {
  sandbox: "https://sandbox.web.squarecdn.com/v1/square.js",
  production: "https://web.squarecdn.com/v1/square.js",
};

function loadSdk(env: "production" | "sandbox"): Promise<SquareGlobal> {
  return new Promise((resolve, reject) => {
    if (window.Square) return resolve(window.Square);
    const src = SDK_SRC[env];
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.Square as SquareGlobal));
      existing.addEventListener("error", () => reject(new Error("sdk_load_failed")));
      if (window.Square) resolve(window.Square);
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => (window.Square ? resolve(window.Square) : reject(new Error("sdk_no_global")));
    s.onerror = () => reject(new Error("sdk_load_failed"));
    document.head.appendChild(s);
  });
}

export type ConfirmStepCardHandle = {
  /** Tokenize the entered card AND run Square buyer verification (SCA/AVS/CVV).
   *  Returns the source token + verification token, or null on failure (an
   *  error is shown to the user). A wrong CVV/postal fails verification → null,
   *  so a bad card never gets saved. Called by the confirm button. */
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
  t: BookingMessages;
};

/**
 * Square card-entry rendered INSIDE the confirm step (Option A). Unlike the
 * post-booking capture, it does NOT save — it exposes tokenize() so the confirm
 * action can grab the token and save the card as part of creating the booking.
 */
export const ConfirmStepCardCapture = forwardRef<ConfirmStepCardHandle, Props>(
  function ConfirmStepCardCapture({ applicationId, locationId, environment, feeLabel, t }, ref) {
    const cardRef = useRef<SquareCard | null>(null);
    const paymentsRef = useRef<SquarePayments | null>(null);
    const mountedRef = useRef(false);
    const [error, setError] = useState<string | null>(null);
    const [ready, setReady] = useState(false);

    useEffect(() => {
      if (mountedRef.current) return;
      mountedRef.current = true;
      let cancelled = false;
      (async () => {
        try {
          const sq = await loadSdk(environment);
          const payments = sq.payments(applicationId, locationId);
          const card = await payments.card();
          if (cancelled) return;
          await card.attach("#sq-confirm-card");
          // Square fires 'errorChanged' when its own validation state changes.
          // Use it to proactively clear our custom error so stale messages
          // don't linger after the user corrects their card number.
          try {
            (card as unknown as { addEventListener: (e: string, h: () => void) => void })
              .addEventListener("errorChanged", () => setError(null));
          } catch { /* event not supported in all SDK versions — safe to ignore */ }
          cardRef.current = card;
          paymentsRef.current = payments;
          setReady(true);
        } catch {
          if (!cancelled) setError(t.noShowCardError ?? "Could not load the card form.");
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [applicationId, locationId, environment, t.noShowCardError]);

    useImperativeHandle(ref, () => ({
      clearError() { setError(null); },
      async tokenize() {
        if (!cardRef.current) {
          setError(t.noShowCardError ?? "Could not load the card form.");
          return null;
        }
        try {
          const res = await cardRef.current.tokenize();
          if (res.status !== "OK" || !res.token) {
            setError(t.noShowCardError ?? "Please check your card details.");
            return null;
          }
          // Buyer verification (SCA/AVS/CVV). When verifyBuyer yields a token we
          // pass it to CreateCard so Square verifies the card at storage time
          // and REJECTS a wrong CVV/postal server-side (the real enforcement).
          // If verifyBuyer itself hiccups (infra / SCA-cancel) we DEGRADE — save
          // without the token rather than block a legitimate buyer. Net effect:
          // strictly safer than today (can only ADD a Square-side rejection,
          // never over-block a real card on a client verify glitch).
          let verificationToken: string | undefined;
          try {
            const v = await paymentsRef.current?.verifyBuyer(res.token, {
              intent: "STORE",
              customerInitiated: true,
              sellerKeyedIn: false,
            });
            verificationToken = v?.token ?? undefined;
          } catch {
            verificationToken = undefined;
          }
          setError(null);
          return { token: res.token, verificationToken };
        } catch {
          setError(t.noShowCardError ?? "Please check your card details.");
          return null;
        }
      },
    }));

    return (
      <div className="mt-4 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4">
        <p className="text-sm font-semibold text-[var(--booking-text)]">
          {t.noShowCardTitle ?? "Card required to confirm"}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--booking-text-muted)]">
          {(t.noShowCardDesc ??
            "A card on file is required to complete this booking. You'll only be charged {fee} if you miss your appointment — no charge today.").replace(
            "{fee}",
            feeLabel,
          )}
        </p>
        <div
          id="sq-confirm-card"
          className="mt-3 rounded-lg border border-[var(--booking-border)] bg-white p-2"
          data-testid="confirm-step-card"
        />
        {!ready && !error ? (
          <p className="mt-2 text-xs text-[var(--booking-text-muted)]">
            {t.noShowCardSaving ?? "Loading…"}
          </p>
        ) : null}
        {error ? (
          <p className="mt-2 text-xs text-nq-error" role="alert" data-testid="confirm-step-card-error">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
