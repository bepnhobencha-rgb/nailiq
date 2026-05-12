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
import { normalizeBookingClosedDateList } from "@/shared/booking/parseBookingClosedDates";
import { updateOpeningHours } from "@/shared/dashboard/setupActions";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

// P0.1 — day-key ordering only; labels resolved at render time.
const DAY_KEYS_ORDERED: DayKey[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

/** P2.7 — compute the Nth occurrence of a weekday in a given month.
 *
 * `month` is 0-indexed (0 = January, 11 = December).
 * `weekday` is 0-indexed (0 = Sunday, 1 = Monday, … 6 = Saturday).
 * `n` is 1-indexed (1 = first, 2 = second, …).
 *
 * Used for North American floating holidays:
 *   - Labour/Labor Day  → first Monday of September   (9 → month 8, weekday 1, n=1)
 *   - Canadian Thanksgiving → second Monday of October (10 → month 9, weekday 1, n=2)
 *   - US Thanksgiving   → fourth Thursday of November  (11 → month 10, weekday 4, n=4)
 *
 * Uses UTC math throughout to avoid local-tz drift; the resulting
 * YYYY-MM-DD is timezone-independent (calendar date only). */
function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  n: number,
): string {
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const firstWeekday = firstOfMonth.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** P1.11 — typical Vietnamese nail-salon hours preset.
 * 10:00–19:00 Mon–Sat, closed Sun. Owners can still tweak afterwards. */
const NAIL_SHOP_PRESET: OpeningHoursWeek = {
  mon: { open: "10:00", close: "19:00", closed: false },
  tue: { open: "10:00", close: "19:00", closed: false },
  wed: { open: "10:00", close: "19:00", closed: false },
  thu: { open: "10:00", close: "19:00", closed: false },
  fri: { open: "10:00", close: "19:00", closed: false },
  sat: { open: "10:00", close: "19:00", closed: false },
  sun: { open: "10:00", close: "19:00", closed: true },
};

const TOAST_GENERIC = "✗ Could not save.";

function openingHoursToastMessage(code: string): string {
  switch (code) {
    case "permission_denied":
      return "✗ Permission denied.";
    case "schema_mismatch":
      return "✗ Database mismatch.";
    case "invalid_hours":
      return "✗ Invalid hour format.";
    case "unauthorized":
      return "✗ Session expired.";
    case "server_error":
      return "✗ Could not save. Check logs or connection.";
    default:
      return TOAST_GENERIC;
  }
}

function openingHoursFailMessage(code: string): string {
  switch (code) {
    case "invalid_hours":
      return "Could not save. Check each day uses times like 09:00–18:00.";
    case "unauthorized":
      return "Session expired — sign in again from /register with your phone number, then retry.";
    case "permission_denied":
      return "Could not save: this account isn’t allowed to update this salon in the database (RLS). Sign out and sign in again, or check that Salon members includes your account.";
    case "schema_mismatch":
      return "Could not save: database is missing a column (often booking_closed_dates). Apply the latest Supabase migrations to your project, then try again.";
    case "server_error":
      return "Could not save. If you’re offline, reconnect; otherwise ask an admin to check server logs for [updateOpeningHours].";
    default:
      return "Could not save. If you edited extra closed dates, use only YYYY-MM-DD (one per line). Otherwise try again.";
  }
}

function toTimeInput(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return "09:00";
  const h = String(Math.min(23, Number(m[1]))).padStart(2, "0");
  const mi = String(Math.min(59, Number(m[2]))).padStart(2, "0");
  return `${h}:${mi}`;
}

function closedDatesInitialText(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  const lines = raw
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean);
  return normalizeBookingClosedDateList(lines).join("\n");
}

export function HoursSetupPanel({
  slug,
  initialRaw,
  initialClosedDatesRaw,
}: {
  slug: string;
  initialRaw: unknown;
  initialClosedDatesRaw: unknown;
}) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const labels = getUserMessages(language).setupLabels;
  const [hours, setHours] = useState<OpeningHoursWeek>(() =>
    parseOpeningHours(initialRaw) ?? defaultOpeningHoursWeek(),
  );
  const [closedDatesText, setClosedDatesText] = useState(() =>
    closedDatesInitialText(initialClosedDatesRaw),
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
    setClosedDatesText(closedDatesInitialText(initialClosedDatesRaw));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [initialClosedDatesRaw, initialRaw]);

  const preview = useMemo(() => compactOpeningHoursLabel(hours), [hours]);

  const onSaveAll = useCallback(async () => {
    setError(null);
    clearStatusTimer();
    setSaveStatus("saving");
    const closedYmd = normalizeBookingClosedDateList(
      closedDatesText
        .split(/\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const res = await updateOpeningHours(slug, hours, closedYmd);
    if (!res.ok) {
      setSaveStatus("error");
      setError(openingHoursFailMessage(res.error));
      setToast({ variant: "error", message: openingHoursToastMessage(res.error) });
      statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000);
      return;
    }
    setSaveStatus("saved");
    setToast({ variant: "success", message: labels.hoursSaved });
    statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
    router.refresh();
  }, [clearStatusTimer, closedDatesText, hours, labels.hoursSaved, router, slug]);

  return (
    <div className="flex flex-col gap-6">
      <SetupToast toast={toast} onDismiss={() => setToast(null)} />

      <p className="text-sm leading-snug text-nq-muted">{labels.hoursIntro}</p>
      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="hours-shortcuts"
      >
        <button
          type="button"
          data-testid="hours-preset-nail-shop"
          disabled={saveStatus === "saving"}
          onClick={() => {
            // P1.11 — overwrite the editor (not the saved row) so the
            // owner still sees the existing Save button + can review
            // before persisting. Doesn't auto-save; matches the rest
            // of this panel's "edit then Save all" model.
            setHours(NAIL_SHOP_PRESET);
          }}
          className="inline-flex min-h-9 items-center rounded-full border border-nq-primary/45 bg-nq-primary/10 px-3 py-1 text-xs font-semibold text-nq-primary hover:bg-nq-primary/15 disabled:opacity-50"
        >
          ⚡ Giờ tiệm nail phổ biến · 10:00–19:00, đóng CN
        </button>
        <button
          type="button"
          data-testid="hours-apply-monday-to-all"
          disabled={saveStatus === "saving"}
          onClick={() => {
            // P1.11 — copy Monday's open/close + closed flag to every
            // other day. Most salons run the same hours Mon–Sat, so
            // this saves 6× clicking through individual day pickers.
            setHours((prev) => {
              const mon = prev.mon;
              return {
                mon,
                tue: { ...mon },
                wed: { ...mon },
                thu: { ...mon },
                fri: { ...mon },
                sat: { ...mon },
                sun: { ...mon },
              };
            });
          }}
          className="inline-flex min-h-9 items-center rounded-full border border-nq-border/60 bg-nq-surface/60 px-3 py-1 text-xs font-medium text-nq-foreground hover:bg-nq-surface disabled:opacity-50"
        >
          📋 Áp dụng cho tất cả ngày · Apply Monday to all
        </button>
      </div>
      {error ? (
        <p className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          {error}
        </p>
      ) : null}
      <section className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-4">
        <ul className="flex flex-col divide-y divide-nq-border/30">
          {DAY_KEYS_ORDERED.map((key) => {
            const day = hours[key];
            const label = labels.days[key];
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
                    {labels.closed}
                  </label>
                </div>
                {!day.closed ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="block text-sm font-medium text-nq-muted">
                      {labels.opens}
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
                      {labels.closes}
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

      <section className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-4">
        <label className="block text-sm font-medium text-nq-muted">
          {labels.extraClosedDates}
          <textarea
            className="mt-2 min-h-[120px] w-full resize-y rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2 font-mono text-sm tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
            placeholder={"2026-01-01\n2026-12-25"}
            value={closedDatesText}
            disabled={saveStatus === "saving"}
            onChange={(e) => setClosedDatesText(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        {/* P2.7 — North American holiday quick-add chips. NailIQ is
            launching for nail salons in Canada and the US, so the
            preset list reflects the holidays nail shops in those
            markets most commonly close on. Tapping appends the
            chosen date (current year) to the textarea on its own
            line, dedup'd. Owners can still edit freely. Floating
            holidays (Labour Day, Thanksgiving) are computed for the
            current year via `nthWeekdayOfMonth`. */}
        <div
          className="mt-3 flex flex-wrap gap-2"
          data-testid="hours-holiday-presets"
        >
          {(() => {
            const year = new Date().getFullYear();
            const PRESETS: Array<{ label: string; date: string }> = [
              { label: "🎆 New Year · Jan 1", date: `${year}-01-01` },
              {
                label: "🇨🇦 Canada Day · Jul 1",
                date: `${year}-07-01`,
              },
              {
                label: "🇺🇸 Independence Day · Jul 4",
                date: `${year}-07-04`,
              },
              {
                // First Monday of September. Same date for both
                // Canadian "Labour Day" and US "Labor Day".
                label: "👷 Labour Day",
                date: nthWeekdayOfMonth(year, 8, 1, 1),
              },
              {
                // Second Monday of October — Canada only.
                label: "🍂 Thanksgiving (CA)",
                date: nthWeekdayOfMonth(year, 9, 1, 2),
              },
              {
                // Fourth Thursday of November — US only.
                label: "🦃 Thanksgiving (US)",
                date: nthWeekdayOfMonth(year, 10, 4, 4),
              },
              {
                label: "🎄 Christmas · Dec 25",
                date: `${year}-12-25`,
              },
              {
                // Boxing Day is observed in Canada; included as a
                // common closure for CA-based salons.
                label: "🎁 Boxing Day · Dec 26",
                date: `${year}-12-26`,
              },
            ];
            return PRESETS.map((p) => (
              <button
                key={p.date}
                type="button"
                data-testid={`hours-holiday-${p.date}`}
                disabled={saveStatus === "saving"}
                onClick={() => {
                  setClosedDatesText((prev) => {
                    const lines = prev
                      .split(/\n/)
                      .map((s) => s.trim())
                      .filter(Boolean);
                    if (lines.includes(p.date)) return prev;
                    lines.push(p.date);
                    return lines.join("\n");
                  });
                }}
                className="inline-flex min-h-8 items-center rounded-full border border-nq-border/60 bg-nq-surface/60 px-2.5 py-1 text-xs font-medium text-nq-foreground hover:bg-nq-surface disabled:opacity-50"
              >
                {p.label}
              </button>
            ));
          })()}
        </div>
      </section>

      <div className="rounded-2xl border border-nq-border/35 bg-nq-bg/80 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
          {labels.hoursPreview}
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
        idleLabel={labels.saveAll}
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
