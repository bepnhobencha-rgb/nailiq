"use client";

import * as Sentry from "@sentry/nextjs";

export function DebugSentryClient() {
  return (
    <button
      type="button"
      className="fixed bottom-3 right-3 z-50 max-w-[8rem] rounded-md border border-transparent px-2 py-1 text-[10px] font-medium text-nq-muted opacity-0 transition-opacity hover:opacity-90 focus-visible:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nq-muted"
      aria-label="Send test error to Sentry"
      title="Sends a sample event to verify Sentry (click to test)"
      onClick={() => {
        const err = new Error(
          "NAILIQ debug-sentry: manual test event (safe to ignore)",
        );
        err.name = "DebugSentryManualTest";
        Sentry.captureException(err);
      }}
    >
      Test Error
    </button>
  );
}
