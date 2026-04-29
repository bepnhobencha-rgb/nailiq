"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SaveButton, type SaveButtonStatus } from "@/components/ui/SaveButton";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import {
  compactOpeningHoursLabel,
  defaultOpeningHoursWeek,
  parseOpeningHours,
  type DayKey,
  type OpeningHoursWeek,
} from "@/shared/dashboard/openingHoursDefaults";
import { updateOpeningHours } from "@/shared/dashboard/setupActions";

const DAY_ORDER: { key: DayKey; label: string }[] = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
];

const TOAST_ERR = "✗ Could not save. Check your connection.";

function toTimeInput(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return "09:00";
  const h = String(Math.min(23, Number(m[1]))).padStart(2, "0");
  const mi = String(Math.min(59, Number(m[2]))).padStart(2, "0");
  return `${h}:${mi}`;
}

export function HoursSetupPanel({
  slug,
  initialRaw,
}: {
  slug: string;
  initialRaw: unknown;
}) {
  const router = useRouter();
  const [hours, setHours] = useState<OpeningHoursWeek>(() =>
    parseOpeningHours(initialRaw) ?? defaultOpeningHoursWeek(),
  );
  const [saveStatus, setSaveStatus] = useState<SaveButtonStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearStatusTimer = useCallback(() => {
    if (statusTimerRef.current !== null) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      clearStatusTimer();
    },
    [clearStatusTimer],
  );

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- props → local editor state */
    setHours(parseOpeningHours(initialRaw) ?? defaultOpeningHoursWeek());
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [initialRaw]);

  const preview = useMemo(() => compactOpeningHoursLabel(hours), [hours]);

  const onSaveAll = useCallback(async () => {
    setError(null);
    clearStatusTimer();
    setSaveStatus("saving");
    const res = await updateOpeningHours(slug, hours);
    if (!res.ok) {
      setSaveStatus("error");
      setError("Could not save opening hours. Try again.");
      setToast({ variant: "error", message: TOAST_ERR });
      statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000);
      return;
    }
    setSaveStatus("saved");
    setToast({ variant: "success", message: "✓ Hours saved" });
    statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
    router.refresh();
  }, [clearStatusTimer, hours, router, slug]);

  return (
    <div className="flex flex-col gap-6">
      <SetupToast toast={toast} onDismiss={() => setToast(null)} />

      <p className="text-sm leading-snug text-nq-muted">
        Set when clients can book. Closed days won&apos;t show slots.
      </p>
      {error ? (
        <p className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          {error}
        </p>
      ) : null}
      <section className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-4">
        <ul className="flex flex-col divide-y divide-nq-border/30">
          {DAY_ORDER.map(({ key, label }) => {
            const day = hours[key];
            return (
              <li key={key} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-base font-medium text-nq-foreground">
                    {label}
                  </span>
                  <label className="inline-flex min-h-11 cursor-pointer touch-manipulation items-center gap-3 text-sm font-medium text-nq-muted">
                    <input
                      type="checkbox"
                      className="h-5 w-5 rounded border-nq-border/60 text-nq-primary focus:ring-nq-primary"
                      checked={day.closed}
                      disabled={saveStatus === "saving"}
                      onChange={(e) => {
                        const closed = e.target.checked;
                        setHours((prev) => ({
                          ...prev,
                          [key]: { ...prev[key], closed },
                        }));
                      }}
                    />
                    Closed
                  </label>
                </div>
                {!day.closed ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="block text-sm font-medium text-nq-muted">
                      Opens
                      <input
                        type="time"
                        className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
                        value={toTimeInput(day.open)}
                        disabled={day.closed || saveStatus === "saving"}
                        onChange={(e) => {
                          const open = hmFromDateInput(e.target.value);
                          setHours((prev) => ({
                            ...prev,
                            [key]: { ...prev[key], open },
                          }));
                        }}
                      />
                    </label>
                    <label className="block text-sm font-medium text-nq-muted">
                      Closes
                      <input
                        type="time"
                        className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
                        value={toTimeInput(day.close)}
                        disabled={day.closed || saveStatus === "saving"}
                        onChange={(e) => {
                          const close = hmFromDateInput(e.target.value);
                          setHours((prev) => ({
                            ...prev,
                            [key]: { ...prev[key], close },
                          }));
                        }}
                      />
                    </label>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <div className="rounded-2xl border border-nq-border/35 bg-nq-bg/80 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
          Preview
        </p>
        <p className="mt-2 text-base leading-snug text-nq-foreground">
          {preview}
        </p>
      </div>

      <SaveButton
        status={saveStatus}
        onSave={() => {
          void onSaveAll();
        }}
        idleLabel="Save all"
        className="min-h-[48px] w-full sm:w-full"
      />
    </div>
  );
}

/** HTML time value "HH:MM" → storage "HH:MM" normalized */
function hmFromDateInput(v: string): string {
  if (!v) return "09:00";
  const [h, m] = v.split(":");
  const hh = Math.min(23, Math.max(0, Number(h))).toString().padStart(2, "0");
  const mm = Math.min(59, Math.max(0, Number(m ?? 0)))
    .toString()
    .padStart(2, "0");
  return `${hh}:${mm}`;
}
