"use client";

import { useState, useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import {
  acknowledgeBookingManagementRequest,
  pendingBookingManagementRequest,
  replacePendingBookingManagementRequestMaterial,
  stableBookingManagementRequestId,
} from "@/shared/booking/bookingManagementRequestId";

type Slot = { label: string; startUtc: string; endUtc: string };
type SequenceReview = {
  sequenceFingerprint: string;
  parentStartTimeUtc: string;
  parentEndTimeUtc: string;
  segments: {
    lineId: string;
    position: number;
    staffName: string;
    customerStartUtc: string;
    customerEndUtc: string;
    prepMinutes: number;
    serviceDurationMinutes: number;
    sequentialAddonMinutes: number;
    trailingBufferMinutes: number;
  }[];
};

type State =
  | { phase: "date" }
  | { phase: "slots"; date: string; slots: Slot[] | null; loading: boolean }
  | { phase: "confirm"; date: string; slot: Slot }
  | { phase: "sequence_review"; date: string; slot: Slot; requestId: string; quote: SequenceReview; changed: boolean }
  | { phase: "submitting" }
  | { phase: "done"; serviceName: string; newStartUtc: string }
  | { phase: "error"; code: string };

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

/** Salon-local YYYY-MM-DD → "Monday, August 16" — device-timezone-independent. */
function formatDateYmd(ymd: string): string {
  try {
    return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "UTC",
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  } catch {
    return ymd;
  }
}

/** Customer-device YYYY-MM-DD — last-resort fallback only, used when the
 *  salon-local date can't be resolved (e.g. invalid token). The date picker
 *  must still render in that case: submitting surfaces the real error
 *  (invalid/expired link) through the existing reschedule-slots error path. */
function deviceTodayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function RescheduleBookingPage() {
  const searchParams = useSearchParams();
  const token = searchParams?.get("token") ?? "";
  const [state, setState] = useState<State>({ phase: "date" });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [minDate, setMinDate] = useState<string | null>(null);
  const [salonTimezone, setSalonTimezone] = useState("UTC");

  // A prior explicit click may have committed while its HTTP response was
  // lost. Recover that exact server-issued UTC intent before asking the
  // consumed token to inspect again; never generate a new request ID.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      const pending = await pendingBookingManagementRequest({ action: "reschedule", token });
      if (!pending || cancelled) return;
      try {
        const material = JSON.parse(pending.material) as {
          date?: unknown; slotLabel?: unknown; newStartUtc?: unknown; newEndUtc?: unknown;
          expectedSequenceFingerprint?: unknown;
        };
        if (![material.date, material.slotLabel, material.newStartUtc, material.newEndUtc]
          .every((value) => typeof value === "string" && value.length > 0)) return;
        const response = await fetch("/api/booking/reschedule-action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, requestId: pending.requestId, ...material }),
        });
        const body = await response.json() as {
          ok?: boolean; code?: string; serviceName?: string; newStartUtc?: string;
          sequenceQuote?: SequenceReview;
        };
        if (cancelled) return;
        if (response.ok && body.ok && body.code === "sequence_review_required" && body.sequenceQuote) {
          const slot = {
            label: String(material.slotLabel),
            startUtc: String(material.newStartUtc),
            endUtc: String(material.newEndUtc),
          };
          setState({
            phase: "sequence_review",
            date: String(material.date),
            slot,
            requestId: pending.requestId,
            quote: body.sequenceQuote,
            changed: false,
          });
        } else if (response.ok && body.ok) {
          await acknowledgeBookingManagementRequest({
            action: "reschedule",
            token,
            material: pending.material,
          });
          setState({
            phase: "done",
            serviceName: body.serviceName ?? "your appointment",
            newStartUtc: body.newStartUtc ?? "",
          });
        } else {
          setState({ phase: "error", code: body.code ?? "management_unavailable" });
        }
      } catch {
        if (!cancelled) setState({ phase: "error", code: "management_unavailable" });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Resolve the salon's own "today" + timezone before showing the date
  // picker — the picker used to default to the CUSTOMER'S DEVICE date, which
  // silently disagreed with the salon's calendar day whenever the two clocks
  // straddled a day boundary. Everything the customer picks is validated
  // against salon-local time server-side either way; this only fixes what's
  // shown as the default/min. If resolution fails (e.g. invalid token), fall
  // back to the device date rather than blocking the picker — the existing
  // "Show Available Times" flow already surfaces the real error correctly.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/booking/reschedule-slots?token=${encodeURIComponent(token)}`);
        const json = (await res.json()) as { todayYmd?: string; timezone?: string; error?: string };
        if (cancelled) return;
        const ymd = res.ok && !json.error && json.todayYmd ? json.todayYmd : deviceTodayYmd();
        if (res.ok && typeof json.timezone === "string" && json.timezone) {
          setSalonTimezone(json.timezone);
        }
        setSelectedDate(ymd);
        setMinDate(ymd);
      } catch {
        if (!cancelled) {
          const ymd = deviceTodayYmd();
          setSelectedDate(ymd);
          setMinDate(ymd);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const loadSlots = useCallback(
    async (date: string) => {
      setState({ phase: "slots", date, slots: null, loading: true });
      try {
        const res = await fetch(
          `/api/booking/reschedule-slots?token=${encodeURIComponent(token)}&date=${date}`,
        );
        const json = (await res.json()) as { slotOptions?: Slot[]; error?: string };
        if (!res.ok || json.error) {
          setState({ phase: "error", code: json.error ?? "load_failed" });
          return;
        }
        setState({ phase: "slots", date, slots: json.slotOptions ?? [], loading: false });
      } catch {
        setState({ phase: "error", code: "network_error" });
      }
    },
    [token],
  );

  async function handleSubmit(date: string, slot: Slot) {
    setState({ phase: "submitting" });
    try {
      const material = JSON.stringify({
        date,
        slotLabel: slot.label,
        newStartUtc: slot.startUtc,
        newEndUtc: slot.endUtc,
      });
      const intent = {
        action: "reschedule" as const,
        token,
        material,
      };
      const requestId = await stableBookingManagementRequestId(intent);
      const res = await fetch("/api/booking/reschedule-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          date,
          slotLabel: slot.label,
          newStartUtc: slot.startUtc,
          newEndUtc: slot.endUtc,
          requestId,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean; code?: string; serviceName?: string; newStartUtc?: string;
        sequenceQuote?: SequenceReview;
      };
      if (json.ok && json.code === "sequence_review_required" && json.sequenceQuote) {
        setState({
          phase: "sequence_review",
          date,
          slot,
          requestId,
          quote: json.sequenceQuote,
          changed: false,
        });
      } else if (json.ok) {
        await acknowledgeBookingManagementRequest(intent);
        setState({
          phase: "done",
          serviceName: json.serviceName ?? "your appointment",
          newStartUtc: json.newStartUtc ?? "",
        });
      } else {
        setState({ phase: "error", code: json.code ?? "unknown" });
      }
    } catch {
      setState({ phase: "error", code: "network_error" });
    }
  }

  async function confirmSequenceReview(
    stateValue: Extract<State, { phase: "sequence_review" }>,
  ) {
    setState({ phase: "submitting" });
    const material = JSON.stringify({
      date: stateValue.date,
      slotLabel: stateValue.slot.label,
      newStartUtc: stateValue.slot.startUtc,
      newEndUtc: stateValue.slot.endUtc,
      expectedSequenceFingerprint: stateValue.quote.sequenceFingerprint,
    });
    const intent = { action: "reschedule" as const, token, material };
    try {
      const quotedMaterial = JSON.stringify({
        date: stateValue.date,
        slotLabel: stateValue.slot.label,
        newStartUtc: stateValue.slot.startUtc,
        newEndUtc: stateValue.slot.endUtc,
      });
      const retained = await replacePendingBookingManagementRequestMaterial({
        ...intent,
        requestId: stateValue.requestId,
        previousMaterial: quotedMaterial,
      });
      if (!retained) throw new Error("pending_material");
      const response = await fetch("/api/booking/reschedule-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          requestId: stateValue.requestId,
          date: stateValue.date,
          slotLabel: stateValue.slot.label,
          newStartUtc: stateValue.slot.startUtc,
          newEndUtc: stateValue.slot.endUtc,
          expectedSequenceFingerprint: stateValue.quote.sequenceFingerprint,
        }),
      });
      const body = await response.json() as {
        ok?: boolean;
        code?: string;
        serviceName?: string;
        newStartUtc?: string;
        quote?: SequenceReview;
      };
      if (body.code === "pricing_changed" && body.quote) {
        const nextMaterial = JSON.stringify({
          date: stateValue.date,
          slotLabel: stateValue.slot.label,
          newStartUtc: stateValue.slot.startUtc,
          newEndUtc: stateValue.slot.endUtc,
          expectedSequenceFingerprint: body.quote.sequenceFingerprint,
        });
        const retained = await replacePendingBookingManagementRequestMaterial({
          action: "reschedule",
          token,
          requestId: stateValue.requestId,
          previousMaterial: material,
          material: nextMaterial,
        });
        if (!retained) throw new Error("pending_material");
        setState({ ...stateValue, quote: body.quote, changed: true });
        return;
      }
      if (!response.ok || body.ok !== true) {
        setState({ phase: "error", code: body.code ?? "management_unavailable" });
        return;
      }
      await acknowledgeBookingManagementRequest(intent);
      setState({
        phase: "done",
        serviceName: body.serviceName ?? "your appointment",
        newStartUtc: body.newStartUtc ?? stateValue.quote.parentStartTimeUtc,
      });
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
            <p className="mt-1 text-sm text-nq-muted">{formatTime(state.newStartUtc, salonTimezone)}</p>
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

  if (state.phase === "sequence_review") {
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-white">Review entire sequence</h1>
        {state.changed ? (
          <p className="mt-3 rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-100">
            Availability changed. Review the updated sequence and confirm again.
          </p>
        ) : null}
        <ol className="mt-5 space-y-3">
          {state.quote.segments.map((segment) => (
            <li key={segment.lineId} className="rounded-xl border border-nq-border/40 bg-nq-bg p-3">
              <p className="font-medium text-nq-text">{segment.position + 1}. {segment.staffName}</p>
              <p className="mt-1 text-sm text-nq-muted">
                {formatTime(segment.customerStartUtc, salonTimezone)} – {formatTime(segment.customerEndUtc, salonTimezone)}
              </p>
              <p className="mt-1 text-xs text-nq-muted">
                Prep {segment.prepMinutes} min · Customer {segment.serviceDurationMinutes + segment.sequentialAddonMinutes} min · Buffer {segment.trailingBufferMinutes} min
              </p>
            </li>
          ))}
        </ol>
        <button
          type="button"
          onClick={() => void confirmSequenceReview(state)}
          className="mt-5 w-full rounded-xl bg-nq-gold px-4 py-3 font-semibold text-black"
        >
          Confirm entire sequence
        </button>
      </Shell>
    );
  }

  if (selectedDate === null) {
    return (
      <Shell>
        <div className="text-center">
          <p className="text-nq-muted">Loading…</p>
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
          min={minDate ?? undefined}
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
          <p className="mb-3 text-xs font-medium uppercase tracking-widest text-nq-gold">
            {state.loading ? "Loading times…" : `Available Times — ${formatDateYmd(state.date)}`}
          </p>
          {state.loading ? null : state.slots && state.slots.length === 0 ? (
            <p className="text-center text-sm text-nq-muted">No available times on this date. Please pick another day.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {(state.slots ?? []).map((slot) => (
                <button
                  key={slot.startUtc}
                  onClick={() => handleSubmit(state.date, slot)}
                  className="rounded-lg border border-nq-border/40 bg-nq-surface py-2 text-sm text-nq-text transition hover:border-nq-gold/50 hover:text-nq-gold"
                >
                  {slot.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

function ErrorView({ code }: { code: string }) {
  const messages: Record<string, string> = {
    missing_token: "This reschedule link is invalid.",
    invalid_request: "This reschedule link is invalid or has expired.",
    invalid_token: "This reschedule link is invalid or has expired.",
    token_invalid: "This link has already been used or has expired.",
    expired_or_revoked: "This link has already been used or has expired.",
    token_consumed: "This link has already been used or has expired.",
    action_mismatch: "This link cannot reschedule an appointment.",
    slot_conflict: "That time slot is no longer available. Please pick another.",
    booking_not_reschedulable: "This appointment can no longer be rescheduled.",
    load_failed: "Could not load available times. Please try again.",
    network_error: "Connection error. Please check your internet and try again.",
    salon_closed_day: "The salon is closed on this date. Please pick another day.",
    outside_opening_hours: "That time is outside business hours. Please pick another time.",
    salon_hours_invalid: "This salon's hours aren't set up correctly. Please contact the salon directly.",
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
