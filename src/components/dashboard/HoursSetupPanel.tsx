"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SaveButton, type SaveButtonStatus } from "@/components/ui/SaveButton";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import { HoursBar } from "@/components/dashboard/HoursBar";
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

// Mon–Fri 9–7, Sat 10–5, Sun closed. Most common schedule for Canadian nail salons.
const PRESET_STANDARD: OpeningHoursWeek = {
  mon: { open: "09:00", close: "19:00", closed: false },
  tue: { open: "09:00", close: "19:00", closed: false },
  wed: { open: "09:00", close: "19:00", closed: false },
  thu: { open: "09:00", close: "19:00", closed: false },
  fri: { open: "09:00", close: "19:00", closed: false },
  sat: { open: "10:00", close: "17:00", closed: false },
  sun: { open: "09:00", close: "19:00", closed: true },
};

// 7 days 9–7, no days off.
const PRESET_7_DAYS: OpeningHoursWeek = {
  mon: { open: "09:00", close: "19:00", closed: false },
  tue: { open: "09:00", close: "19:00", closed: false },
  wed: { open: "09:00", close: "19:00", closed: false },
  thu: { open: "09:00", close: "19:00", closed: false },
  fri: { open: "09:00", close: "19:00", closed: false },
  sat: { open: "09:00", close: "19:00", closed: false },
  sun: { open: "09:00", close: "19:00", closed: false },
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
      return "Could not save: this account isn't allowed to update this salon in the database (RLS). Sign out and sign in again, or check that Salon members includes your account.";
    case "schema_mismatch":
      return "Could not save: database is missing a column (often booking_closed_dates). Apply the latest Supabase migrations to your project, then try again.";
    case "server_error":
      return "Could not save. If you're offline, reconnect; otherwise ask an admin to check server logs for [updateOpeningHours].";
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

// ---------------------------------------------------------------------------
// Master hours derivation helpers
// ---------------------------------------------------------------------------

/** Derive master hours from the most common (open, close) pair among non-closed days. */
function deriveMasterHours(week: OpeningHoursWeek): { open: string; close: string } {
  const counts = new Map<string, number>();
  for (const day of Object.values(week)) {
    if (!day.closed) {
      const key = `${day.open}|${day.close}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best = "09:00|19:00";
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  const [open, close] = best.split("|") as [string, string];
  return { open: open ?? "09:00", close: close ?? "19:00" };
}

/** Derive which days are overridden (differ from master OR are closed). */
function deriveOverriddenDays(
  week: OpeningHoursWeek,
  master: { open: string; close: string },
): Set<DayKey> {
  const s = new Set<DayKey>();
  for (const [key, day] of Object.entries(week) as [DayKey, OpeningHoursWeek[DayKey]][]) {
    if (day.closed || day.open !== master.open || day.close !== master.close) {
      s.add(key);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [hours, setHours] = useState<OpeningHoursWeek>(() =>
    parseOpeningHours(initialRaw) ?? defaultOpeningHoursWeek(),
  );

  const [masterHours, setMasterHours] = useState(() =>
    deriveMasterHours(parseOpeningHours(initialRaw) ?? defaultOpeningHoursWeek()),
  );

  const [overriddenDays, setOverriddenDays] = useState<Set<DayKey>>(() => {
    const w = parseOpeningHours(initialRaw) ?? defaultOpeningHoursWeek();
    return deriveOverriddenDays(w, deriveMasterHours(w));
  });

  const [closedDatesText, setClosedDatesText] = useState(() =>
    closedDatesInitialText(initialClosedDatesRaw),
  );

  const [saveStatus, setSaveStatus] = useState<SaveButtonStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

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
    const w = parseOpeningHours(initialRaw) ?? defaultOpeningHoursWeek();
    const m = deriveMasterHours(w);
    setHours(w);
    setMasterHours(m);
    setOverriddenDays(deriveOverriddenDays(w, m));
    setClosedDatesText(closedDatesInitialText(initialClosedDatesRaw));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [initialClosedDatesRaw, initialRaw]);

  const preview = useMemo(() => compactOpeningHoursLabel(hours), [hours]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  /** Master time changed → propagate to all non-overridden days. */
  const onMasterChange = useCallback(
    (field: "open" | "close", value: string) => {
      setMasterHours((prev) => {
        const newMaster = { ...prev, [field]: value };
        setHours((prevHours) => {
          const next = { ...prevHours };
          for (const key of DAY_KEYS_ORDERED) {
            if (!overriddenDays.has(key)) {
              next[key] = { ...next[key], open: newMaster.open, close: newMaster.close };
            }
          }
          return next;
        });
        return newMaster;
      });
    },
    [overriddenDays],
  );

  /** Day time/closed changed → lock this day as override. */
  const onDayChange = useCallback(
    (key: DayKey, field: "open" | "close" | "closed", value: string | boolean) => {
      setOverriddenDays((prev) => new Set([...prev, key]));
      setHours((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
    },
    [],
  );

  /** "Chỉnh riêng" clicked → add to overrides, keep current time (= master). */
  const onOverrideDay = useCallback((key: DayKey) => {
    setOverriddenDays((prev) => new Set([...prev, key]));
  }, []);

  /** "↺" clicked → remove override, reset to master. */
  const onResetDay = useCallback(
    (key: DayKey) => {
      setOverriddenDays((prev) => {
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
      setHours((prev) => ({
        ...prev,
        [key]: { ...prev[key], open: masterHours.open, close: masterHours.close, closed: false },
      }));
    },
    [masterHours],
  );

  /** Apply a full preset, re-deriving master and overrides. */
  const applyPreset = useCallback((preset: OpeningHoursWeek) => {
    const newMaster = deriveMasterHours(preset);
    setMasterHours(newMaster);
    setOverriddenDays(deriveOverriddenDays(preset, newMaster));
    setHours(preset);
  }, []);

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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6">
      <SetupToast toast={toast} onDismiss={() => setToast(null)} />

      <p className="text-sm leading-snug text-nq-muted">{labels.hoursIntro}</p>

      {/* Preset shortcut buttons */}
      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="hours-shortcuts"
      >
        <Button
          size="sm"
          variant="primary"
          data-testid="hours-preset-standard"
          disabled={saveStatus === "saving"}
          onClick={() => applyPreset(PRESET_STANDARD)}
        >
          Tiệm chuẩn · T2–T6 9–7, T7 10–5
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-testid="hours-preset-7days"
          disabled={saveStatus === "saving"}
          onClick={() => applyPreset(PRESET_7_DAYS)}
        >
          Tuần 7 ngày · 9–7
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="hours-preset-custom"
          disabled={saveStatus === "saving"}
          onClick={() => applyPreset(defaultOpeningHoursWeek())}
        >
          Tự chọn
        </Button>
      </div>

      {/* Master hours card */}
      <div className="rounded-2xl border border-nq-primary/20 bg-nq-primary/5 p-4">
        <p className="mb-3 text-sm font-medium text-nq-foreground">
          {labels.hoursDefaultLabel}
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-nq-muted">
            {labels.opens}
            <input
              type="time"
              className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
              value={toTimeInput(masterHours.open)}
              disabled={saveStatus === "saving"}
              onChange={(e) => onMasterChange("open", hmFromDateInput(e.target.value))}
            />
          </label>
          <label className="block text-sm font-medium text-nq-muted">
            {labels.closes}
            <input
              type="time"
              className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
              value={toTimeInput(masterHours.close)}
              disabled={saveStatus === "saving"}
              onChange={(e) => onMasterChange("close", hmFromDateInput(e.target.value))}
            />
          </label>
        </div>
      </div>

      {error ? (
        <p className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          {error}
        </p>
      ) : null}

      {/* Per-day rows */}
      <section className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-4">
        <ul className="flex flex-col divide-y divide-nq-border/30">
          {DAY_KEYS_ORDERED.map((key) => {
            const day = hours[key];
            const dayLabel = labels.days[key];
            const isOverride = overriddenDays.has(key);

            if (!isOverride) {
              // State A — Following master (collapsed)
              return (
                <li key={key} className="flex flex-col gap-1.5 py-4 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-base font-medium text-nq-foreground">
                      {dayLabel}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-nq-muted">
                        {labels.hoursFollowingDefault}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={saveStatus === "saving"}
                        onClick={() => onOverrideDay(key)}
                      >
                        {labels.hoursCustomize}
                      </Button>
                    </div>
                  </div>
                  <HoursBar
                    open={day.open}
                    close={day.close}
                    closed={day.closed}
                    isOverride={false}
                  />
                </li>
              );
            }

            // State B — Overridden (expanded)
            const timeRangeDisplay = day.closed
              ? language === "vi"
                ? "Đóng cửa"
                : "Closed"
              : `${toTimeInput(day.open)} – ${toTimeInput(day.close)}`;

            return (
              <li
                key={key}
                className="flex flex-col gap-3 border-l-2 border-nq-warning/60 py-4 pl-3 first:pt-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-base font-medium text-nq-foreground">
                    {dayLabel}
                    <span className="ml-2 text-sm font-normal text-nq-muted">
                      {timeRangeDisplay}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saveStatus === "saving"}
                    onClick={() => onResetDay(key)}
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    {labels.hoursResetToDefault}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  {!day.closed ? (
                    <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="block text-sm font-medium text-nq-muted">
                        {labels.opens}
                        <input
                          type="time"
                          className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
                          value={toTimeInput(day.open)}
                          disabled={day.closed || saveStatus === "saving"}
                          onChange={(e) =>
                            onDayChange(key, "open", hmFromDateInput(e.target.value))
                          }
                        />
                      </label>
                      <label className="block text-sm font-medium text-nq-muted">
                        {labels.closes}
                        <input
                          type="time"
                          className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
                          value={toTimeInput(day.close)}
                          disabled={day.closed || saveStatus === "saving"}
                          onChange={(e) =>
                            onDayChange(key, "close", hmFromDateInput(e.target.value))
                          }
                        />
                      </label>
                    </div>
                  ) : null}
                  <label className="inline-flex min-h-11 cursor-pointer touch-manipulation items-center gap-3 text-sm font-medium text-nq-muted">
                    <input
                      type="checkbox"
                      className="h-5 w-5 rounded border-nq-border/60 text-nq-primary focus:ring-nq-primary"
                      checked={day.closed}
                      disabled={saveStatus === "saving"}
                      onChange={(e) => onDayChange(key, "closed", e.target.checked)}
                    />
                    {labels.closed}
                  </label>
                </div>
                <HoursBar
                  open={day.open}
                  close={day.close}
                  closed={day.closed}
                  isOverride={true}
                />
              </li>
            );
          })}
        </ul>
      </section>

      {/* Holiday chips + closed dates textarea */}
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

      {/* Preview */}
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
