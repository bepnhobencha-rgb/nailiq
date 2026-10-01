"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  acknowledgeBookingManagementRequest,
  existingBookingManagementRequestId,
} from "@/shared/booking/bookingManagementRequestId";
import { waitlistClaimRequestId } from "@/shared/booking/waitlistClaimRecovery";

type State =
  | { kind: "idle" | "recovery" }
  | { kind: "submitting" }
  | { kind: "booked" | "claimed" | "unavailable" | "error" };

export function WaitlistClaimButton({ token, isAvailable = true }: { token: string; isAvailable?: boolean }) {
  const [state, setState] = useState<State>({ kind: isAvailable ? "idle" : "unavailable" });
  const inFlight = useRef(false);

  useEffect(() => {
    if (isAvailable) return;
    let mounted = true;
    // Read local replay metadata only. Never fetch or mutate on mount/reload.
    void existingBookingManagementRequestId({ action: "waitlist_claim", token })
      .then((requestId) => {
        if (mounted && requestId && !inFlight.current) setState({ kind: "recovery" });
      })
      .catch(() => { /* Storage denied: retain the private unavailable result. */ });
    return () => { mounted = false; };
  }, [token, isAvailable]);

  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ kind: "submitting" });
    try {
      const intent = { action: "waitlist_claim" as const, token };
      // Recovery can only POST an existing intent; never mint a replacement ID.
      const requestId = await waitlistClaimRequestId(token, isAvailable);
      if (!requestId) {
        setState({ kind: "unavailable" });
        return;
      }
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
      if (response.ok && result?.ok === true && (result.outcome === "booked" || result.outcome === "claimed")) {
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
    } finally {
      inFlight.current = false;
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

  if (!isAvailable) {
    return (
      <div className="text-center">
        <h1 className="text-xl font-semibold text-white">Check your previous claim</h1>
        <p className="mt-3 text-sm text-nq-muted">
          Your last request may have succeeded. Check its result before trying to book again.
        </p>
        <Button size="lg" fullWidth disabled={state.kind === "submitting"}
          aria-busy={state.kind === "submitting"} onClick={submit} className="mt-6">
          {state.kind === "submitting" ? "Checking…" : "Check previous claim"}
        </Button>
      </div>
    );
  }

  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold text-white">A spot is available</h1>
      <p className="mt-3 text-sm text-nq-muted">
        Confirm below to claim it. Opening this page alone does not reserve the spot.
      </p>
      <Button
        type="button"
        size="lg"
        fullWidth
        disabled={state.kind === "submitting"}
        aria-busy={state.kind === "submitting"}
        onClick={submit}
        className="mt-6"
      >
        {state.kind === "submitting" ? "Claiming…" : "Claim this spot"}
      </Button>
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
        <Button
          type="button"
          variant="secondary"
          size="lg"
          onClick={retry}
          className="mt-6"
        >
          Try again
        </Button>
      ) : null}
    </div>
  );
}
