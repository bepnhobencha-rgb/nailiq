"use client";

import { useEffect, useState, useTransition } from "react";
import { endImpersonationAndRedirect } from "@/shared/superadmin/impersonationActions";
import type { ImpersonationMeta } from "@/shared/superadmin/impersonationTypes";

/**
 * Sticky top banner shown while an impersonation session is active.
 *
 * Renders:
 *   - "Viewing <salon> as <role>" label
 *   - Countdown to the 30-min hard expiry (mm:ss, ticks each second)
 *   - When expiry hits zero, label flips to "Session expired —
 *     re-authenticate to continue" and the Exit button is disabled
 *     (the dashboard layout's `expireImpersonationIfStale` will
 *     clear cookies on the next navigation)
 *   - "Exit impersonation" button — danger variant, routes through
 *     `endImpersonationAndRedirect` so the cookie swap commits in
 *     the action's response
 */
export function ImpersonationBannerInner({
  meta,
}: {
  meta: ImpersonationMeta;
}) {
  const [now, setNow] = useState<number>(() => Date.now());
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const expiresAt = new Date(meta.expiresAt).getTime();
  const remainingMs = Math.max(0, expiresAt - now);
  const isExpired = remainingMs === 0;

  const totalSec = Math.floor(remainingMs / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");

  const onExit = () => {
    startTransition(() => {
      void endImpersonationAndRedirect();
    });
  };

  return (
    <div
      role="alert"
      data-testid="impersonation-banner"
      data-expired={isExpired ? "true" : "false"}
      className="sticky top-0 z-50 w-full border-b border-nq-error/40 bg-nq-error/95 text-white shadow-md backdrop-blur"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm md:px-6">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            aria-hidden
            className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/15 text-xs font-bold"
          >
            !
          </span>
          {isExpired ? (
            <span className="font-medium">
              Session expired — re-authenticate to continue.
            </span>
          ) : (
            <>
              <span className="font-medium">
                Viewing{" "}
                <strong className="font-bold">{meta.salonName}</strong> as{" "}
                <strong className="font-bold">{meta.ownerRole}</strong>
              </span>
              <span
                aria-label="Time remaining"
                className="ml-2 inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 font-mono text-xs tabular-nums"
              >
                <span aria-hidden>⏱</span>
                {mm}:{ss}
              </span>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onExit}
          disabled={pending || isExpired}
          data-testid="impersonation-exit"
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-white px-3 text-xs font-semibold tracking-wide text-nq-error uppercase transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Exiting…" : "Exit impersonation"}
        </button>
      </div>
    </div>
  );
}
