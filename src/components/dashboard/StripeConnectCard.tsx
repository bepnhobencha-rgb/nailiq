"use client";

import { useEffect, useState, useTransition } from "react";
import {
  refreshStripeConnectStatus,
  startStripeConnectOnboarding,
} from "@/shared/dashboard/stripeConnectActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  initialChargesEnabled: boolean;
  initialDetailsSubmitted: boolean;
  initialHasAccount: boolean;
};

/**
 * Salon-facing Stripe Connect onboarding card. Lets the owner connect their own
 * Stripe account so deposits (Phase 2) are charged on it. No money moves here.
 */
export function StripeConnectCard({
  slug,
  initialChargesEnabled,
  initialDetailsSubmitted,
  initialHasAccount,
}: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [charges, setCharges] = useState(initialChargesEnabled);
  const [submitted, setSubmitted] = useState(initialDetailsSubmitted);
  const [hasAccount, setHasAccount] = useState(initialHasAccount);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // After returning from Stripe-hosted onboarding, pull fresh status.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("stripe_connect");
    if (p !== "return" && p !== "refresh") return;
    startTransition(async () => {
      const res = await refreshStripeConnectStatus(slug);
      if (res.ok) {
        setCharges(res.status.chargesEnabled);
        setSubmitted(res.status.detailsSubmitted);
        setHasAccount(Boolean(res.status.accountId));
      }
    });
    // clean the query param so a refresh doesn't re-trigger
    const url = new URL(window.location.href);
    url.searchParams.delete("stripe_connect");
    window.history.replaceState({}, "", url.toString());
  }, [slug]);

  function connect() {
    setError(null);
    startTransition(async () => {
      const res = await startStripeConnectOnboarding(slug);
      if (res.ok) {
        window.location.assign(res.url);
      } else {
        setError(
          res.error === "connect_not_enabled"
            ? vi
              ? "Cần bật Connect trong Stripe Dashboard của bạn trước."
              : "Enable Connect in your Stripe Dashboard first."
            : vi
              ? "Không kết nối được, thử lại."
              : "Couldn't start onboarding, try again.",
        );
      }
    });
  }

  const status: "connected" | "pending" | "none" = charges
    ? "connected"
    : hasAccount || submitted
      ? "pending"
      : "none";

  const badge =
    status === "connected"
      ? { txt: vi ? "Đã kết nối" : "Connected", cls: "border-emerald-400/40 bg-emerald-400/10 text-emerald-400" }
      : status === "pending"
        ? { txt: vi ? "Đang hoàn tất" : "Pending", cls: "border-amber-400/40 bg-amber-400/10 text-amber-400" }
        : { txt: vi ? "Chưa kết nối" : "Not connected", cls: "border-nq-border/40 bg-white/5 text-nq-muted" };

  return (
    <section
      data-testid="settings-stripe-connect"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-nq-foreground">
          {vi ? "Kết nối Stripe (nhận tiền cọc)" : "Connect Stripe (receive deposits)"}
        </p>
        <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}>
          {badge.txt}
        </span>
      </div>
      <p className="mt-1 text-xs text-nq-muted">
        {vi
          ? "Tiền cọc của khách sẽ vào thẳng tài khoản Stripe của tiệm bạn. Nhấn để hoàn tất xác minh với Stripe."
          : "Customer deposits go straight to your own Stripe account. Click to complete verification with Stripe."}
      </p>
      {status !== "connected" ? (
        <button
          type="button"
          disabled={pending}
          onClick={connect}
          className="mt-3 rounded-full bg-nq-primary px-4 py-2 text-sm font-medium text-nq-on-primary disabled:opacity-50"
        >
          {pending
            ? vi ? "Đang mở…" : "Opening…"
            : hasAccount
              ? vi ? "Tiếp tục xác minh" : "Continue verification"
              : vi ? "Kết nối Stripe" : "Connect Stripe"}
        </button>
      ) : null}
      {error ? <p className="mt-2 text-xs text-nq-error">{error}</p> : null}
    </section>
  );
}
