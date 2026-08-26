"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatBookingManagementTime } from "@/shared/booking/bookingManagementTime";

type Snapshot = {
  status: string;
  startTimeUtc: string;
  endTimeUtc: string;
  serviceName: string | null;
  staffName: string | null;
  salonSlug: string;
  salonName: string;
  salonTimezone: string;
};

export default function BookingStatusPage() {
  const token = useSearchParams()?.get("token")?.trim() ?? "";
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState(token ? "" : "invalid_token");

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch(
          `/api/booking/status?token=${encodeURIComponent(token)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const body = await response.json() as { ok?: boolean; code?: string; booking?: Snapshot };
        if (controller.signal.aborted) return;
        if (!response.ok || !body.ok || !body.booking) {
          setError(body.code ?? "management_unavailable");
          setSnapshot(null);
          return;
        }
        setSnapshot(body.booking);
        setError("");
      } catch {
        if (!controller.signal.aborted) setError("management_unavailable");
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-nq-bg px-4">
      <main className="w-full max-w-sm rounded-2xl border border-nq-border/40 bg-nq-surface p-8 text-center">
        <h1 className="text-2xl font-semibold text-white">Appointment Status</h1>
        {error ? (
          <p className="mt-4 text-sm text-nq-muted">
            {error === "management_unavailable"
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
            <a className="mt-6 inline-block underline" href={`/${encodeURIComponent(snapshot.salonSlug)}`}>
              View salon
            </a>
          </div>
        ) : (
          <p className="mt-4 text-sm text-nq-muted">Loading…</p>
        )}
      </main>
    </div>
  );
}
