"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

export default function CancelBookingPage() {
  const searchParams = useSearchParams();
  const token = searchParams?.get("token") ?? "";
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [code, setCode] = useState("");
  const [salonSlug, setSalonSlug] = useState<string | null>(null);

  async function handleCancel() {
    if (!token) { setState("error"); setCode("missing_token"); return; }
    setState("loading");

    try {
      const res = await fetch("/api/booking/cancel-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const json = (await res.json()) as { ok?: boolean; code?: string; salonSlug?: string | null };
      if (json.ok) {
        if (json.salonSlug) setSalonSlug(json.salonSlug);
        setState("done");
      } else {
        setState("error");
        setCode(json.code ?? "unknown");
      }
    } catch {
      setState("error");
      setCode("server_error");
    }
  }

  if (state === "done") {
    return (
      <Shell>
        <div className="text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-nq-border bg-nq-surface">
            <svg className="h-8 w-8 text-nq-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-white">Appointment Cancelled</h1>
          <p className="mt-3 text-sm text-nq-muted">
            Your appointment has been cancelled. We hope to see you again soon.
          </p>
          {salonSlug && (
            <div className="mt-6">
              <a
                href={`/${salonSlug}?ref=cancel_page`}
                className="inline-block rounded-xl border border-nq-border/60 bg-nq-surface px-6 py-3 text-sm font-medium text-white transition hover:bg-nq-border/20"
              >
                📅 Book another time
              </a>
            </div>
          )}
        </div>
      </Shell>
    );
  }

  const errorMessages: Record<string, string> = {
    missing_token: "This cancellation link is invalid.",
    token_invalid: "This link has already been used or has expired.",
    booking_not_cancellable: "This appointment cannot be cancelled at this time.",
    server_error: "Something went wrong. Please contact the salon directly.",
  };

  if (state === "error") {
    return (
      <Shell>
        <div className="text-center">
          <h1 className="text-xl font-semibold text-white">Unable to Cancel</h1>
          <p className="mt-3 text-sm text-nq-muted">{errorMessages[code] ?? "An unexpected error occurred."}</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-white">Cancel Appointment</h1>
        <p className="mt-3 text-sm text-nq-muted">
          Are you sure you want to cancel your appointment?
        </p>
        <div className="mt-8 flex flex-col gap-3">
          <button
            onClick={handleCancel}
            disabled={state === "loading"}
            className="w-full rounded-xl border border-red-500/40 bg-red-500/10 py-3 text-sm font-medium text-red-400 transition hover:bg-red-500/20 disabled:opacity-50"
          >
            {state === "loading" ? "Cancelling…" : "Yes, cancel my appointment"}
          </button>
          <button
            onClick={() => window.history.back()}
            className="w-full rounded-xl border border-nq-border/40 py-3 text-sm text-nq-muted transition hover:text-nq-text"
          >
            Keep my appointment
          </button>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-nq-bg px-4">
      <div className="w-full max-w-sm rounded-2xl border border-nq-border/40 bg-nq-surface p-8">
        {children}
        <p className="mt-8 text-center text-xs text-nq-muted/50">
          Powered by <a href="https://nailiq.ca" className="underline">NailIQ</a>
        </p>
      </div>
    </div>
  );
}
