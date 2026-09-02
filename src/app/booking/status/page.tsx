"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatBookingManagementTime } from "@/shared/booking/bookingManagementTime";
import {
  presentTurnIqCustomerEta,
  type TurnIqCustomerEtaPresentationInput,
} from "@/shared/turniq/customerEtaPresentation";

type Snapshot = {
  status: string;
  startTimeUtc: string;
  endTimeUtc: string;
  serviceName: string | null;
  staffName: string | null;
  salonSlug: string;
  salonName: string;
  salonTimezone: string;
  turnIqEta: (TurnIqCustomerEtaPresentationInput & {
    estimateFingerprint: string;
  }) | null;
};

export default function BookingStatusPage() {
  const token = useSearchParams()?.get("token")?.trim() ?? "";
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [fatalError, setFatalError] = useState(token ? "" : "invalid_token");
  const [connectionLimited, setConnectionLimited] = useState(false);
  const [clientNowMs, setClientNowMs] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch(
          `/api/booking/status?token=${encodeURIComponent(token)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const body = await response.json() as {
          ok?: boolean;
          code?: string;
          booking?: Omit<Snapshot, "turnIqEta">;
          turnIqEta?: Snapshot["turnIqEta"];
        };
        if (controller.signal.aborted) return;
        if (!response.ok || !body.ok || !body.booking) {
          setFatalError(body.code ?? "management_unavailable");
          setSnapshot(null);
          return;
        }
        setSnapshot({ ...body.booking, turnIqEta: body.turnIqEta ?? null });
        setFatalError("");
        setConnectionLimited(false);
        setClientNowMs(Date.now());
      } catch {
        if (!controller.signal.aborted) {
          setConnectionLimited(true);
          setClientNowMs(Date.now());
        }
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [token]);

  const etaPresentation = snapshot?.turnIqEta
    ? presentTurnIqCustomerEta(
        snapshot.turnIqEta,
        clientNowMs,
        connectionLimited,
      )
    : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-nq-bg px-4">
      <main className="w-full max-w-sm rounded-2xl border border-nq-border/40 bg-nq-surface p-8 text-center">
        <h1 className="text-2xl font-semibold text-white">Appointment Status</h1>
        {fatalError ? (
          <p className="mt-4 text-sm text-nq-muted">
            {fatalError === "management_unavailable"
              ? "Status is temporarily unavailable. Please contact the salon."
              : "This status link is invalid or has expired."}
          </p>
        ) : snapshot ? (
          <div className="mt-5 text-sm text-nq-muted">
            <p className="text-base font-medium capitalize text-nq-gold">{snapshot.status}</p>
            {snapshot.serviceName && <p className="mt-3 font-medium text-white">{snapshot.serviceName}</p>}
            {snapshot.staffName && <p>{snapshot.staffName}</p>}
            <p className="mt-2">
              {formatBookingManagementTime(snapshot.startTimeUtc, snapshot.salonTimezone) ??
                "Salon local time unavailable — please contact the salon."}
            </p>
            {etaPresentation && (
              <section
                aria-label="Estimated wait"
                className="mt-5 rounded-xl border border-nq-gold/35 bg-nq-bg/70 p-4 text-left"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-nq-gold">
                  {etaPresentation.headline}
                </p>
                {etaPresentation.waitLabel && (
                  <p className="mt-1 text-3xl font-semibold text-white">
                    {etaPresentation.waitLabel}
                  </p>
                )}
                <p className="mt-2 text-sm text-nq-muted">
                  {etaPresentation.detail}
                </p>
                {etaPresentation.partyLabel && (
                  <p className="mt-2 text-xs text-nq-muted">
                    {etaPresentation.partyLabel}
                  </p>
                )}
                {etaPresentation.limitedConnection && (
                  <p className="mt-3 text-xs font-medium text-amber-300" role="status">
                    Connection is limited. NailIQ will refresh automatically.
                  </p>
                )}
              </section>
            )}
            {connectionLimited && !etaPresentation && (
              <p className="mt-4 text-xs text-amber-300" role="status">
                Connection is limited. Showing the last confirmed appointment status.
              </p>
            )}
            <a className="mt-6 inline-block underline" href={`/${encodeURIComponent(snapshot.salonSlug)}`}>
              View salon
            </a>
          </div>
        ) : connectionLimited ? (
          <p className="mt-4 text-sm text-nq-muted" role="status">
            Status is temporarily unavailable. NailIQ will try again automatically.
          </p>
        ) : (
          <p className="mt-4 text-sm text-nq-muted">Loading…</p>
        )}
      </main>
    </div>
  );
}
