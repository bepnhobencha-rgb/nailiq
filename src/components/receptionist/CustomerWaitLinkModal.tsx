"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/shared/lib/cn";

/**
 * QR + copy-link share modal for the customer wait page. Built as a
 * standalone component (not extending the locked Modal primitive)
 * because the Foundation Freeze list doesn't include a Modal yet —
 * this is a one-screen receptionist affordance, kept compact.
 *
 * QR is generated via the public `qrserver.com` endpoint so we
 * don't add a runtime dependency for a single use case. The URL
 * itself is harmless to share — guessing a 16-byte UUID is the
 * effective bearer token.
 */

const QR_API = "https://api.qrserver.com/v1/create-qr-code/";

export type CustomerWaitLinkModalProps = {
  open: boolean;
  /** Full URL the QR code encodes; the modal also surfaces it as
   * copyable text + a tap-to-open link. */
  url: string;
  /** Customer's display name — surfaced as a sub-line so the
   * receptionist can confirm they're showing the right QR. */
  customerName: string;
  onClose: () => void;
  labels: {
    title: string;
    /** "Show this QR to {name} or copy the link." */
    instruction: string;
    copyLink: string;
    copied: string;
    openLink: string;
    closeAria: string;
  };
};

export function CustomerWaitLinkModal({
  open,
  url,
  customerName,
  onClose,
  labels,
}: CustomerWaitLinkModalProps) {
  const [copied, setCopied] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) closeBtnRef.current?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ARCHITECTURE_LOCK: reset copy state when modal opens/url changes
    setCopied(false);
  }, [open, url]);

  // Esc closes — modal traps focus loosely; the desk is touch-first.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const qrSrc = `${QR_API}?size=240x240&data=${encodeURIComponent(url)}`;

  const handleCopy = () => {
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => {
        /* ignore — desk has the URL on screen as fallback */
      });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={labels.title}
      data-testid="customer-wait-link-modal"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
    >
      <div
        role="document"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-nq-muted/30 bg-nq-surface p-5 text-center shadow-nq-card"
      >
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-base font-semibold text-nq-foreground">
            {labels.title}
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label={labels.closeAria}
            onClick={onClose}
            className="rounded-md px-2 py-1 text-nq-muted hover:bg-nq-bg hover:text-nq-foreground"
          >
            ×
          </button>
        </div>
        <p className="mt-1 text-xs text-nq-muted">
          {labels.instruction.replace("{name}", customerName)}
        </p>

        <div className="mt-4 inline-flex items-center justify-center rounded-xl bg-white p-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- external QR endpoint, no Next/Image optimization needed */}
          <img
            alt={labels.title}
            src={qrSrc}
            width={240}
            height={240}
            className="h-60 w-60"
          />
        </div>

        <p className="mt-3 break-all rounded-md border border-nq-muted/30 bg-nq-bg px-2 py-1.5 text-[11px] font-mono text-nq-muted">
          {url}
        </p>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={handleCopy}
            data-testid="customer-wait-link-copy"
            className={cn(
              "min-h-10 flex-1 rounded-lg border px-3 text-sm font-semibold transition-colors",
              copied
                ? "border-emerald-400/55 bg-emerald-400/15 text-emerald-700"
                : "border-nq-muted/40 bg-transparent text-nq-foreground hover:border-nq-muted",
            )}
          >
            {copied ? labels.copied : labels.copyLink}
          </button>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-10 flex-1 items-center justify-center rounded-lg border border-nq-muted/40 bg-transparent px-3 text-sm font-medium text-nq-muted hover:border-nq-muted hover:text-nq-foreground"
          >
            {labels.openLink}
          </a>
        </div>
      </div>
    </div>
  );
}
