"use client";

import { useState } from "react";
import {
  acknowledgeBookingManagementRequest,
  stableBookingManagementRequestId,
} from "@/shared/booking/bookingManagementRequestId";

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "booked" | "claimed" | "unavailable" | "error" };

export function WaitlistClaimButton({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function submit() {
    if (state.kind === "submitting") return;
    setState({ kind: "submitting" });
    try {
      const intent = { action: "waitlist_claim" as const, token };
      const requestId = await stableBookingManagementRequestId(intent);
      const response = await fetch("/api/booking/waitlist-claim", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, requestId }),
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: unknown;
        outcome?: unknown;
      } | null;
      if (response.ok && result?.ok === true) {
        await acknowledgeBookingManagementRequest(intent);
        setState({ kind: result.outcome === "booked" ? "booked" : "claimed" });
      } else if (response.status === 409 || response.status === 400) {
        await acknowledgeBookingManagementRequest(intent);
        setState({ kind: "unavailable" });
      } else {
        setState({ kind: "error" });
      }
    } catch {
      setState({ kind: "error" });
    }
  }

  if (state.kind === "booked") {
    return <Success message="Your appointment is booked. The salon will follow up with the details." />;
  }
  if (state.kind === "claimed") {
    return <Success message="Your spot is reserved. The salon will follow up to confirm the details." />;
  }
  if (state.kind === "unavailable") {
    return <Message title="Slot unavailable" body="This claim link is no longer available." />;
  }
  if (state.kind === "error") {
    return <Message title="Please try again" body="We could not complete the claim right now." retry={submit} />;
  }

  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold text-white">A spot is available</h1>
      <p className="mt-3 text-sm text-nq-muted">
        Confirm below to claim it. Opening this page alone does not reserve the spot.
      </p>
      <button
        type="button"
        disabled={state.kind === "submitting"}
        onClick={submit}
        className="mt-6 w-full rounded-xl bg-nq-primary px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
      >
        {state.kind === "submitting" ? "Claiming…" : "Claim this spot"}
      </button>
    </div>
  );
}

function Success({ message }: { message: string }) {
  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold text-white">Confirmed</h1>
      <p className="mt-3 text-sm text-nq-muted">{message}</p>
    </div>
  );
}

function Message({ title, body, retry }: { title: string; body: string; retry?: () => void }) {
  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold text-white">{title}</h1>
      <p className="mt-3 text-sm text-nq-muted">{body}</p>
      {retry ? (
        <button
          type="button"
          onClick={retry}
          className="mt-6 rounded-xl border border-nq-border px-4 py-2 text-sm text-white"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
