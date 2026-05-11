"use client";

import { getCustomerWaitMessages } from "@/shared/i18n/customerWait";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

/**
 * Friendly fallback when `loadCustomerWaitState` returns `ok: false`.
 *
 * We deliberately avoid `notFound()` (which renders the global 404
 * page) — customers reaching this URL via QR / SMS read a hard 404
 * as "salon's link is broken." The far-more-common reality is that
 * the booking was cancelled, completed, or pre-dates the wait page
 * launch. A muted "we can't find this booking" screen with the
 * salon name preserved is a calmer dead-end.
 */
export function CustomerWaitNotFound({
  reason,
  slug,
}: {
  reason: "not_found" | "wrong_salon" | "server_error" | "invalid_id";
  slug: string;
}) {
  const { language } = useUserLanguage();
  const messages = getCustomerWaitMessages(language);

  const isServerError = reason === "server_error";

  return (
    <main
      data-testid="customer-wait-not-found"
      data-reason={reason}
      className="flex min-h-[100dvh] w-full flex-col items-center justify-center bg-nq-bg px-4 py-8"
    >
      <div className="w-full max-w-sm">
        <h1 className="text-center text-base font-bold uppercase tracking-[0.18em] text-nq-foreground">
          {slug}
        </h1>
        <section className="mt-8 rounded-3xl border border-nq-muted/30 bg-nq-surface px-5 py-10 text-center">
          <p className="text-5xl opacity-60" aria-hidden>
            {isServerError ? "⚠️" : "·"}
          </p>
          <p className="mt-4 text-base font-semibold text-nq-foreground">
            {isServerError ? messages.tryAgainLater : messages.notFound}
          </p>
          <p className="mt-2 text-xs text-nq-muted">
            {messages.contactSalon}
          </p>
        </section>
      </div>
    </main>
  );
}
