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
 * Safari/Chrome. Parents may show it proactively after hydration or after the
 * Square SDK reports an error.
 */
export function CardWebviewFallback({
  hint,
  copyLabel,
  copiedLabel,
  openChromeLabel,
  forceVisible = false,
}: {
  hint: string;
  copyLabel: string;
  copiedLabel: string;
  openChromeLabel?: string;
  /** Parent already detected a WebView after hydration. */
  forceVisible?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  if (!forceVisible && !isInAppBrowser()) return null;

  const url = typeof window !== "undefined" ? window.location.href : "";
  const android =
    typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
  const chromeIntentUrl =
    android && typeof window !== "undefined"
      ? `intent://${window.location.host}${window.location.pathname}${window.location.search}#Intent;scheme=${window.location.protocol.replace(":", "")};package=com.android.chrome;end`
      : null;

  const onCopy = () => {
    try {
      const write = navigator.clipboard?.writeText(url);
      if (!write) return;
      void write
        .then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        })
        .catch(() => {
          // Clipboard permission failures reject asynchronously on iOS Safari
          // and embedded browsers. The URL remains visible for manual copy.
          setCopied(false);
        });
    } catch {
      /* clipboard blocked in some WebViews — the URL is shown for manual copy */
      setCopied(false);
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
      {chromeIntentUrl ? (
        <a
          href={chromeIntentUrl}
          className="mt-2 flex h-11 w-full items-center justify-center rounded-lg bg-[var(--salon-primary)] text-xs font-semibold text-white"
          data-testid="card-webview-open-chrome"
        >
          {openChromeLabel ?? "Open in Chrome"}
        </a>
      ) : null}
      <button
        type="button"
        onClick={onCopy}
        className="mt-2 h-11 w-full rounded-lg border border-[var(--booking-border)] text-xs font-semibold text-[var(--booking-text)]"
      >
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}
