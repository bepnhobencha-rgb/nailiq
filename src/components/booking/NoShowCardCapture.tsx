"use client";

import { useEffect, useRef, useState } from "react";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { NoShowCardCaptureStripe } from "./NoShowCardCaptureStripe";

type CaptureProps = {
  bookingId: string;
  /** Formats cents → display string (e.g. "$20.00") in the salon currency. */
  currencyFormat: (cents: number) => string;
  t: BookingMessages;
};

/**
 * Dispatcher: a Stripe-provider salon shows the one-tap Payment Element (Apple/
 * Google Pay); a Square salon shows the card-entry form below. Renders nothing
 * until it knows, and nothing when no card is required for this booking.
 */
export function NoShowCardCapture(props: CaptureProps) {
  const [stripeCfg, setStripeCfg] = useState<{
    required: boolean;
    clientSecret?: string;
    publishableKey?: string;
    feeCents?: number;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/booking/stripe-setup-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId: props.bookingId }),
    })
      .then((r) => r.json())
      .then((c) => {
        if (alive) setStripeCfg(c);
      })
      .catch(() => {
        if (alive) setStripeCfg({ required: false });
      });
    return () => {
      alive = false;
    };
  }, [props.bookingId]);

  if (stripeCfg === null) return null; // still deciding which provider
  if (stripeCfg.required && stripeCfg.clientSecret && stripeCfg.publishableKey) {
    return (
      <NoShowCardCaptureStripe
        bookingId={props.bookingId}
        clientSecret={stripeCfg.clientSecret}
        publishableKey={stripeCfg.publishableKey}
        feeLabel={props.currencyFormat(stripeCfg.feeCents ?? 0)}
        t={props.t}
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

// Minimal shape of the Square Web Payments SDK we use.
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

/**
 * Post-booking no-show protection (Square card-on-file). Fetches its own config;
 * renders nothing unless the booking is risk-gated and Square is configured.
 * The card is saved (not charged); the salon bills the fee only on a no-show.
 */
/** Square card-entry capture (Web Payments SDK). Used when the salon's provider
 *  is Square. The Stripe path (one-tap wallets) is handled by the dispatcher. */
function SquareCardCapture({ bookingId, currencyFormat, t }: CaptureProps) {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);
  const cardRef = useRef<SquareCard | null>(null);
  const paymentsRef = useRef<SquarePayments | null>(null);
  const mountedRef = useRef(false);

  // 1. Decide whether to show + get the SDK params.
  useEffect(() => {
    let alive = true;
    fetch(`/api/booking/square-noshow-config?bookingId=${encodeURIComponent(bookingId)}`)
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
  }, [bookingId]);

  // 2. Init the Square card form once we know we need it.
  useEffect(() => {
    if (!cfg?.required || !cfg.applicationId || !cfg.locationId || mountedRef.current) {
      return;
    }
    mountedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const sq = await loadSdk(cfg.environment ?? "production");
        const payments = sq.payments(cfg.applicationId!, cfg.locationId!);
        const card = await payments.card();
        if (cancelled) return;
        await card.attach("#sq-noshow-card");
        cardRef.current = card;
        paymentsRef.current = payments;
      } catch {
        if (!cancelled) {
          setStatus("error");
          setErrorMsg(t.noShowCardError ?? "Could not load the card form.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg, t.noShowCardError]);

  async function onSave() {
    if (!cardRef.current || status === "saving" || !consented) return;
    setStatus("saving");
    setErrorMsg(null);
    try {
      const result = await cardRef.current.tokenize();
      if (result.status !== "OK" || !result.token) {
        setStatus("error");
        setErrorMsg(t.noShowCardError ?? "Please check your card details.");
        return;
      }
      // Buyer verification (SCA/AVS/CVV) — rejects a wrong CVV/postal before the
      // card is ever vaulted. A failure blocks the save.
      let verificationToken: string | undefined;
      try {
        const v = await paymentsRef.current?.verifyBuyer(result.token, {
          intent: "STORE",
          customerInitiated: true,
          sellerKeyedIn: false,
        });
        verificationToken = v?.token ?? undefined;
        if (!verificationToken) {
          setStatus("error");
          setErrorMsg(t.noShowCardError ?? "Please check your card details.");
          return;
        }
      } catch {
        setStatus("error");
        setErrorMsg(t.noShowCardError ?? "Please check your card details.");
        return;
      }
      const res = await fetch("/api/booking/square-save-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingId,
          sourceId: result.token,
          consent: true,
          verificationToken,
        }),
      });
      const j = (await res.json()) as { ok?: boolean };
      if (j.ok) {
        setStatus("saved");
      } else {
        setStatus("error");
        setErrorMsg(t.noShowCardError ?? "Could not save the card.");
      }
    } catch {
      setStatus("error");
      setErrorMsg(t.noShowCardError ?? "Could not save the card.");
    }
  }

  if (!cfg?.required) return null;

  const feeLabel = currencyFormat(cfg.feeCents ?? 0);

  if (status === "saved") {
    return (
      <div
        className="mt-5 rounded-xl border border-nq-success/40 bg-nq-success/10 px-4 py-3 text-sm text-nq-success"
        data-testid="noshow-card-saved"
      >
        ✓ {(t.noShowCardSaved ?? "Card saved — you're only charged {fee} if you no-show.").replace("{fee}", feeLabel)}
      </div>
    );
  }

  return (
    <div className="mt-5 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4 sm:p-5">
      <p className="text-sm font-semibold text-[var(--booking-text)]">
        {t.noShowCardTitle ?? "Secure your appointment"}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-[var(--booking-text-muted)]">
        {(t.noShowCardDesc ?? "Add a card to hold your spot. You're only charged {fee} if you don't show up — nothing now.").replace("{fee}", feeLabel)}
      </p>
      <div
        id="sq-noshow-card"
        className="mt-3 rounded-lg border border-[var(--booking-border)] bg-white p-2"
      />
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
        disabled={status === "saving" || !consented}
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
