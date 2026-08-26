"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  acknowledgeBookingManagementRequest,
  replayExistingBookingManagementRequest,
  stableBookingManagementRequestId,
} from "@/shared/booking/bookingManagementRequestId";
import { formatBookingManagementTime } from "@/shared/booking/bookingManagementTime";

type Booking = {
  status: string;
  startTimeUtc: string;
  endTimeUtc: string;
  serviceName?: string | null;
  staffName?: string | null;
  salonSlug?: string;
  salonName?: string;
  salonTimezone: string;
};

type State =
  | { phase: "loading" }
  | { phase: "ready"; booking: Booking }
  | { phase: "submitting"; booking: Booking }
  | { phase: "done"; booking: Booking }
  | { phase: "error"; code: string };

export default function ConfirmBookingPage() {
  const token = useSearchParams()?.get("token")?.trim() ?? "";
  const requestId = useRef<string>("");
  const [state, setState] = useState<State>(
    token ? { phase: "loading" } : { phase: "error", code: "missing_token" },
  );

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const intent = { action: "confirm" as const, token };
        const replay = await replayExistingBookingManagementRequest(intent, async (storedRequestId) => {
          requestId.current = storedRequestId;
          const response = await fetch("/api/booking/confirm-action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, requestId: storedRequestId }),
            signal: controller.signal,
          });
          const body = await response.json() as { ok?: boolean; code?: string; booking?: Booking };
          return {
            acknowledged: response.ok && body.ok === true,
            value: { response, body },
          };
        });
        if (controller.signal.aborted) return;
        if (replay) {
          if (replay.value.response.ok && replay.value.body.ok && replay.value.body.booking) {
            setState({ phase: "done", booking: replay.value.body.booking });
          } else {
            setState({ phase: "error", code: replay.value.body.code ?? "management_unavailable" });
          }
          return;
        }
        const response = await fetch(
          `/api/booking/confirm-action?token=${encodeURIComponent(token)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const body = await response.json() as { ok?: boolean; code?: string; booking?: Booking };
        if (controller.signal.aborted) return;
        if (!response.ok || !body.ok || !body.booking) {
          setState({ phase: "error", code: body.code ?? "management_unavailable" });
          return;
        }
        setState({ phase: "ready", booking: body.booking });
      } catch {
        if (!controller.signal.aborted) {
          setState({ phase: "error", code: "management_unavailable" });
        }
      }
    })();
    return () => controller.abort();
  }, [token]);

  async function confirm(booking: Booking): Promise<void> {
    if (!token) return;
    const intent = { action: "confirm" as const, token };
    if (!requestId.current) requestId.current = await stableBookingManagementRequestId(intent);
    setState({ phase: "submitting", booking });
    try {
      const response = await fetch("/api/booking/confirm-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, requestId: requestId.current }),
      });
      const body = await response.json() as { ok?: boolean; code?: string; booking?: Booking };
      if (!response.ok || !body.ok) {
        setState({ phase: "error", code: body.code ?? "management_unavailable" });
        return;
      }
      await acknowledgeBookingManagementRequest(intent);
      setState({ phase: "done", booking: { ...booking, ...body.booking } });
    } catch {
      // Keep requestId stable. A retry recovers an acknowledged DB commit whose
      // HTTP response was lost without applying the action twice.
      setState({ phase: "ready", booking });
    }
  }

  if (state.phase === "loading") {
    return <Shell><p className="text-center text-sm text-nq-muted">Checking your appointment…</p></Shell>;
  }
  if (state.phase === "error") return <ErrorView code={state.code} />;
  if (state.phase === "done") return <ConfirmedView booking={state.booking} />;

  const submitting = state.phase === "submitting";
  return (
    <Shell>
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-white">Confirm Appointment</h1>
        <AppointmentSummary booking={state.booking} />
        <p className="mt-6 text-sm text-nq-muted">
          Please confirm that you plan to attend this appointment.
        </p>
        <button
          type="button"
          disabled={submitting}
          onClick={() => void confirm(state.booking)}
          className="mt-6 w-full rounded-xl border border-nq-gold/40 bg-nq-gold/10 py-3 text-sm font-medium text-nq-gold transition hover:bg-nq-gold/20 disabled:opacity-50"
        >
          {submitting ? "Confirming…" : "Yes, confirm my appointment"}
        </button>
      </div>
    </Shell>
  );
}

function AppointmentSummary({ booking }: { booking: Booking }) {
  return (
    <div className="mt-4 text-nq-muted">
      {booking.serviceName && <p className="font-medium text-nq-text">{booking.serviceName}</p>}
      {booking.staffName && <p className="text-sm">{booking.staffName}</p>}
      <p className="mt-1 text-sm">
        {formatBookingManagementTime(booking.startTimeUtc, booking.salonTimezone) ??
          "Salon local time unavailable — please contact the salon."}
      </p>
    </div>
  );
}

function ConfirmedView({ booking }: { booking: Booking }) {
  return (
    <Shell>
      <div className="text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-nq-gold/30 bg-nq-gold/10 text-2xl text-nq-gold">✓</div>
        <h1 className="text-2xl font-semibold text-white">Appointment Confirmed</h1>
        <AppointmentSummary booking={booking} />
        <p className="mt-6 text-sm text-nq-muted">We look forward to seeing you.</p>
      </div>
    </Shell>
  );
}

function ErrorView({ code }: { code: string }) {
  const messages: Record<string, string> = {
    missing_token: "This confirmation link is invalid.",
    invalid_token: "This confirmation link is invalid.",
    token_invalid: "This link has expired or is no longer available.",
    action_mismatch: "This link cannot confirm an appointment.",
    already_confirmed: "This appointment is already confirmed.",
    management_unavailable: "This link is temporarily unavailable. Please contact the salon.",
    invalid_management_response: "This link is temporarily unavailable. Please contact the salon.",
  };
  return (
    <Shell>
      <div className="text-center">
        <h1 className="text-xl font-semibold text-white">Link Unavailable</h1>
        <p className="mt-3 text-sm text-nq-muted">{messages[code] ?? "Unable to confirm this appointment."}</p>
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
