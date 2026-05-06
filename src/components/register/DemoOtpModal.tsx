"use client";

import { useCallback, useEffect, useState } from "react";

const DISMISS_MS = 30_000;

export function DemoOtpModal({
  code,
  open,
  onDismiss,
  onContinue,
}: {
  code: string;
  open: boolean;
  onDismiss: () => void;
  /** e.g. navigate to OTP entry */
  onContinue?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      onDismiss();
    }, DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [open, onDismiss, code]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }, [code]);

  if (!open) return null;

  return (
    <div
      className="fade-in fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal
      aria-labelledby="demo-otp-title"
    >
      <div className="w-full max-w-sm rounded-2xl border-2 border-nq-primary bg-[#0B0C10] p-5 shadow-[0_0_40px_-8px_rgba(212,175,55,0.35)]">
        <p
          id="demo-otp-title"
          className="text-center text-xs font-medium uppercase tracking-[0.2em] text-nq-muted"
        >
          Demo mode
        </p>
        <p className="mt-3 text-center text-base text-nq-muted">
          Your OTP
          <span className="sr-only"> is shown for local development only</span>
        </p>
        <p
          className="mt-2 text-center font-mono text-2xl tracking-[0.2em] text-nq-primary"
          data-testid="demo-otp-value"
        >
          {code}
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex h-11 min-h-11 flex-1 items-center justify-center rounded-xl border border-nq-primary/40 bg-nq-primary/10 text-sm font-medium text-nq-primary transition-opacity duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copied ? "Copied" : "Copy code"}
          </button>
          {onContinue ? (
            <button
              type="button"
              onClick={onContinue}
              className="inline-flex h-11 min-h-11 flex-1 items-center justify-center rounded-xl border border-nq-border/50 bg-nq-surface/50 text-sm font-medium text-nq-foreground transition-opacity duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
            >
              Enter code
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex h-11 min-h-11 min-w-full flex-1 items-center justify-center rounded-xl border border-nq-border/50 bg-nq-surface/50 text-sm font-medium text-nq-foreground transition-opacity duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg sm:min-w-0"
          >
            Dismiss
          </button>
        </div>
        <p className="mt-3 text-center text-[11px] text-nq-muted/80">
          Auto-dismisses in 30 seconds. Never enable in production.
        </p>
      </div>
    </div>
  );
}
