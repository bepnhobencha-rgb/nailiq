"use client";

import { useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";

type Slot = {
  label: string;
  displayLabel: string;
  startUtc?: string;
};

type State =
  | { phase: "date" }
  | { phase: "slots"; date: string; slots: Slot[] | null; loading: boolean }
  | { phase: "confirm"; date: string; slot: Slot }
  | { phase: "submitting" }
  | { phase: "done"; serviceName: string; newStartUtc: string; timezone: string }
  | { phase: "error"; code: string };

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime(isoUtc: string, timezone: string): string {
  try {
    return new Date(isoUtc).toLocaleString("en-US", {
      timeZone: timezone,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return isoUtc;
  }
}

export default function RescheduleBookingPage() {
  const searchParams = useSearchParams();
  const token = searchParams?.get("token") ?? "";
  const [state, setState] = useState<State>({ phase: "date" });
  const [selectedDate, setSelectedDate] = useState(todayYmd());

  const loadSlots = useCallback(
    async (date: string) => {
      setState({ phase: "slots", date, slots: null, loading: true });
      try {
        const res = await fetch(
          `/api/booking/reschedule-slots?token=${encodeURIComponent(token)}&date=${date}`,
        );
        const json = (await res.json()) as {
          slots?: string[];
          slotOptions?: Slot[];
          timezone?: string;
          error?: string;
        };
        if (!res.ok || json.error) {
          setState({ phase: "error", code: json.error ?? "load_failed" });
          return;
        }
        const slots =
          json.slotOptions ??
          (json.slots ?? []).map((label) => ({
            label,
            displayLabel: label,
          }));
        setState({ phase: "slots", date, slots, loading: false });
      } catch {
        setState({ phase: "error", code: "network_error" });
      }
    },
    [token],
  );

  async function handleSubmit(date: string, slot: Slot) {
    setState({ phase: "submitting" });
    try {
      const res = await fetch("/api/booking/reschedule-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          date,
          slotLabel: slot.label,
          startUtc: slot.startUtc,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        code?: string;
        serviceName?: string;
        newStartUtc?: string;
        timezone?: string;
      };
      if (json.ok) {
        setState({
          phase: "done",
          serviceName: json.serviceName ?? "your appointment",
          newStartUtc: json.newStartUtc ?? "",
          timezone: json.timezone ?? "UTC",
        });
      } else {
        setState({ phase: "error", code: json.code ?? "unknown" });
      }
    } catch {
      setState({ phase: "error", code: "network_error" });
    }
  }

  if (!token) return <Shell><ErrorView code="missing_token" /></Shell>;

  if (state.phase === "done") {
    return (
      <Shell>
        <div className="text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-nq-gold/30 bg-nq-gold/10">
            <svg className="h-8 w-8 text-nq-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-white">Rescheduled!</h1>
          <p className="mt-3 text-nq-muted">
            <span className="font-medium text-nq-text">{state.serviceName}</span>
          </p>
          {state.newStartUtc && (
            <p className="mt-1 text-sm text-nq-muted">
              {formatTime(state.newStartUtc, state.timezone)}
            </p>
          )}
          <p className="mt-6 text-sm text-nq-muted">You can close this page.</p>
        </div>
      </Shell>
    );
  }

  if (state.phase === "error") {
    return <Shell><ErrorView code={state.code} /></Shell>;
  }

  if (state.phase === "submitting") {
    return (
      <Shell>
        <div className="text-center">
          <p className="text-nq-muted">Rescheduling…</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-xl font-semibold text-white">Reschedule Appointment</h1>

      {/* Date picker */}
      <div className="mt-6">
        <label className="block text-xs font-medium uppercase tracking-widest text-nq-gold">
          New Date
        </label>
        <input
          type="date"
          min={todayYmd()}
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="mt-2 w-full rounded-xl border border-nq-border/40 bg-nq-bg px-4 py-3 text-nq-text focus:border-nq-gold/50 focus:outline-none"
        />
        <button
          onClick={() => loadSlots(selectedDate)}
          className="mt-3 w-full rounded-xl bg-nq-gold/10 border border-nq-gold/30 py-3 text-sm font-medium text-nq-gold transition hover:bg-nq-gold/20"
        >
          Show Available Times
        </button>
      </div>

      {/* Slot grid */}
      {state.phase === "slots" && (
        <div className="mt-6">
          {state.loading ? (
            <p className="text-center text-sm text-nq-muted">Loading slots…</p>
          ) : state.slots && state.slots.length === 0 ? (
            <p className="text-center text-sm text-nq-muted">No available times on this date. Please pick another day.</p>
          ) : (
            <>
              <p className="mb-3 text-xs font-medium uppercase tracking-widest text-nq-gold">
                Available Times
              </p>
              <div className="grid grid-cols-3 gap-2">
                {(state.slots ?? []).map((slot) => (
                  <button
                    key={slot.startUtc ?? slot.label}
                    onClick={() => handleSubmit(state.date, slot)}
                    className="rounded-lg border border-nq-border/40 bg-nq-surface py-2 text-sm text-nq-text transition hover:border-nq-gold/50 hover:text-nq-gold"
                  >
                    {slot.displayLabel}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Shell>
  );
}

function ErrorView({ code }: { code: string }) {
  const messages: Record<string, string> = {
    missing_token: "This reschedule link is invalid.",
    token_invalid: "This link has already been used or has expired.",
    slot_conflict: "That time slot is no longer available. Please pick another.",
    resource_conflict: "That time no longer has an available station. Please pick another.",
    staff_unavailable: "Your selected technician is not available at that time.",
    staff_break: "That time overlaps the technician's break. Please pick another.",
    outside_shift: "That time is outside the technician's shift.",
    outside_hours: "That time is outside the salon's booking hours.",
    booking_not_reschedulable: "This appointment can no longer be rescheduled.",
    load_failed: "Could not load available times. Please try again.",
    network_error: "Connection error. Please check your internet and try again.",
  };
  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold text-white">Unable to Reschedule</h1>
      <p className="mt-3 text-sm text-nq-muted">{messages[code] ?? "An unexpected error occurred."}</p>
    </div>
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
