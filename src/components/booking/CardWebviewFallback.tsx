"use client";

import { useState } from "react";

import { isInAppBrowser } from "@/shared/lib/inAppBrowser";

/**
 * Fallback shown on the card step ONLY when the Square SDK failed to load AND
 * the visitor is inside a social-media in-app browser (Instagram/Facebook/…),
 * where Square's payment iframe is unreliable. Gives the customer a way out:
 * copy the booking link and reopen it in Safari/Chrome to finish.
 *
 * Renders nothing when not in an in-app browser, so it never appears in normal
 * Safari/Chrome and never touches the happy path. The parent only mounts it
 * inside its error branch, so a working card form is completely unaffected.
 */
export function CardWebviewFallback({
  hint,
  copyLabel,
  copiedLabel,
}: {
  hint: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  if (!isInAppBrowser()) return null;

  const url = typeof window !== "undefined" ? window.location.href : "";

  const onCopy = () => {
    try {
      void navigator.clipboard?.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked in some WebViews — the URL is shown for manual copy */
    }
  };

  return (
    <div
      className="mt-2 rounded-lg border border-[var(--booking-border)] bg-[var(--booking-bg-input)] p-3"
      data-testid="card-webview-fallback"
    >
      <p className="text-xs leading-relaxed text-[var(--booking-text)]">{hint}</p>
      {url ? (
        <p className="mt-2 break-all text-[11px] text-[var(--booking-text-muted)]">
          {url}
        </p>
      ) : null}
      <button
        type="button"
        onClick={onCopy}
        className="mt-2 h-9 w-full rounded-lg border border-[var(--booking-border)] text-xs font-semibold text-[var(--booking-text)]"
      >
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}
