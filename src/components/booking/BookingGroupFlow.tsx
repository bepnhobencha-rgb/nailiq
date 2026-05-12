"use client";

import { useEffect, useMemo, useState } from "react";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type {
  BookingSalonMeta,
  BookingStaffItem,
} from "@/shared/booking/loadBookingServices";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import {
  loadGroupSmartSchedule,
  type GroupArrangement,
  type GroupArrivalPreference,
  type GroupSmartScheduleResult,
} from "@/shared/booking/loadGroupSmartSchedule";
import {
  submitGroupBooking,
  type GroupBookingMember,
  type GroupBookingResult,
} from "@/shared/booking/submitGroupBooking";
import {
  buildCapabilityMap,
  filterStaffCapableForService,
} from "@/shared/booking/staffCapability";
import {
  parseOpeningHours,
  type DayKey,
  type OpeningHoursWeek,
} from "@/shared/dashboard/openingHoursDefaults";
import { formatCurrency } from "@/shared/lib/currencyFormat";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import { formatPhoneInputProgressive } from "@/shared/lib/phoneFormat";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { formatInSalonTz, salonToday } from "@/shared/lib/salonTime";
import { cn } from "@/shared/lib/cn";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import { Button } from "@/components/ui/Button";

/**
 * Group booking — AI Arrival-First redesign (May 2026).
 *
 * Replaces the previous "shared date + shared time + per-member
 * service/staff" model with a 5-step arrival-first flow. The earlier
 * model forced the customer to guess a time that worked for the
 * whole group; the AI flow asks for an arrival *window* (morning /
 * afternoon / evening / specific) and lets the scheduler propose 3
 * arrangements based on real-time staff availability.
 *
 *   STEP 1  Number of people     — pill selector 2…maxGroupSize
 *   STEP 2  Service & Staff      — per-member: name + service +
 *                                  preferred staff (or "Any")
 *   STEP 3  Date & Arrival window — date + 4 arrival pills
 *                                  ("Morning / Afternoon / Evening /
 *                                  Specific time"); specific reveals
 *                                  a native time input
 *   STEP 4  AI Arrangement        — 3 option cards from
 *                                  `loadGroupSmartSchedule`:
 *                                  Best ✨ · Alternative · Earliest
 *   STEP 5  Confirm               — summary + contact + submit
 *
 * State is hoisted to this component so back-navigation preserves
 * everything the user already entered. The stepper at the top is the
 * single source of navigation truth — clicking earlier steps jumps
 * back (and clears arrangement results, which depend on data the
 * user is about to re-pick).
 *
 * Reuses (NEVER reimplements):
 *   - `loadGroupSmartSchedule` for the AI core (server action;
 *     ultimately reuses `salonTime`, `conflictCheck`-equivalent
 *     overlap, `staffCapability`).
 *   - `submitGroupBooking` for the final atomic write. The chosen
 *     arrangement's per-member start times are passed straight
 *     through (each member is treated as a normal group booking row
 *     by the existing RPC).
 */

const ARRIVAL_PRESETS: ReadonlyArray<
  Exclude<GroupArrivalPreference, { kind: "specific" }>["kind"]
> = ["morning", "afternoon", "evening"];

type Step = 1 | 2 | 3 | 4 | 5 | "success";

type MemberDraft = {
  name: string;
  serviceId: string;
  /** `null` = "Any available". String UUID = explicit pick. */
  preferredStaffId: string | null;
};

function blankMember(): MemberDraft {
  return { name: "", serviceId: "", preferredStaffId: null };
}

function addDaysYmd(ymd: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const x = new Date(Date.UTC(y, mo - 1, d + days));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
}

const DAY_KEY_BY_INDEX: readonly DayKey[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];
function dayKeyForYmd(ymd: string): DayKey | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const idx = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  ).getUTCDay();
  return DAY_KEY_BY_INDEX[idx] ?? null;
}

type BookingGroupFlowProps = {
  t: BookingMessages;
  shopSlug: string;
  services: readonly BookingServiceItem[];
  staff: readonly BookingStaffItem[];
  salon: BookingSalonMeta;
  /** `Math.min(activeStaffCount, HARD_GROUP_CAP)` — drives the
   *  size pill grid. The DB function allows up to 8; this is a
   *  UX cap, not a security check. */
  maxGroupSize: number;
  /** Optional staff capability rows for the salon. Threaded
   *  through so step 2's staff dropdown can filter by service. */
  capabilityRows?: { staff_id: string; service_id: string }[] | null;
};

export function BookingGroupFlow({
  t,
  shopSlug,
  services,
  staff,
  salon,
  maxGroupSize,
  capabilityRows,
}: BookingGroupFlowProps) {
  // ── Wizard state (hoisted; preserves on back-nav) ──────────────
  const [step, setStep] = useState<Step>(1);
  const [size, setSize] = useState(2);
  const [members, setMembers] = useState<MemberDraft[]>(() => [
    blankMember(),
    blankMember(),
  ]);
  const [date, setDate] = useState("");
  const [arrivalKind, setArrivalKind] = useState<
    GroupArrivalPreference["kind"]
  >("morning");
  const [specificTime, setSpecificTime] = useState("");
  const [primaryPhone, setPrimaryPhone] = useState("");
  const [primaryEmail, setPrimaryEmail] = useState("");

  // Smart-schedule results.
  const [scheduling, setScheduling] = useState(false);
  const [scheduleResult, setScheduleResult] =
    useState<GroupSmartScheduleResult | null>(null);
  const [selectedArrangementIdx, setSelectedArrangementIdx] = useState(0);

  // Submit state.
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<{
    groupId: string;
    bookingIds: string[];
  } | null>(null);

  // Per-field error sets for the wizard step validations.
  const [stepErrors, setStepErrors] = useState<Set<string>>(() => new Set());

  const groupCopy = (t.groupBooking ?? {}) as NonNullable<
    BookingMessages["groupBooking"]
  >;

  // ── Derived ────────────────────────────────────────────────────
  const capability = useMemo(
    () => buildCapabilityMap(capabilityRows ?? null),
    [capabilityRows],
  );

  const dateBounds = useMemo(() => {
    const today = salonToday(salon.timezone);
    return { min: today, max: addDaysYmd(today, 90) };
  }, [salon.timezone]);

  const openingWeek: OpeningHoursWeek | null = useMemo(
    () => parseOpeningHours(salon.opening_hours),
    [salon.opening_hours],
  );
  const dayHours = useMemo(() => {
    if (!openingWeek || !date) return null;
    const key = dayKeyForYmd(date);
    if (!key) return null;
    return openingWeek[key];
  }, [openingWeek, date]);
  const isSelectedDayClosed = !!dayHours?.closed;

  // Totals — sum of service prices + max member duration (the
  // group "spans" that long when aligned).
  const totals = useMemo(() => {
    let cents = 0;
    let anyPriced = false;
    let maxMin = 0;
    for (const m of members) {
      const svc = services.find((s) => s.id === m.serviceId);
      if (!svc) continue;
      if (svc.priceCents != null) {
        anyPriced = true;
        cents += svc.priceCents;
      }
      if (svc.totalMinutes > maxMin) maxMin = svc.totalMinutes;
    }
    return { totalCents: anyPriced ? cents : null, maxMinutes: maxMin };
  }, [members, services]);

  const totalDisplay = useMemo(() => {
    if (totals.totalCents == null) return null;
    return formatCurrency(totals.totalCents, salon.currencyCode) ?? null;
  }, [totals.totalCents, salon.currencyCode]);

  // Same staff twice → soft warning only (scheduler will stagger).
  const duplicateStaffIdx = useMemo(() => {
    const seen = new Map<string, number>();
    const dupes = new Set<number>();
    for (let i = 0; i < members.length; i++) {
      const sid = members[i].preferredStaffId;
      if (!sid) continue;
      if (seen.has(sid)) dupes.add(i);
      else seen.set(sid, i);
    }
    return dupes;
  }, [members]);

  const arrivalPref: GroupArrivalPreference = useMemo(() => {
    if (arrivalKind === "specific") {
      return { kind: "specific", time: specificTime };
    }
    return { kind: arrivalKind };
  }, [arrivalKind, specificTime]);

  // ── Helpers ────────────────────────────────────────────────────
  function applySize(n: number) {
    const clamped = Math.max(2, Math.min(maxGroupSize, Math.round(n)));
    setSize(clamped);
    setMembers((prev) => {
      const next: MemberDraft[] = [];
      for (let i = 0; i < clamped; i++) {
        next.push(prev[i] ?? blankMember());
      }
      return next;
    });
    setStepErrors(new Set());
  }

  function patchMember(i: number, patch: Partial<MemberDraft>) {
    setMembers((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], ...patch };
      // If the service changed, drop a preferred staff who isn't
      // capable of the new service to avoid stale ghosts.
      if (patch.serviceId !== undefined && capability) {
        const sid = next[i].preferredStaffId;
        if (sid && !(capability.get(sid)?.has(patch.serviceId) ?? false)) {
          next[i] = { ...next[i], preferredStaffId: null };
        }
      }
      return next;
    });
    setStepErrors((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      next.delete(`m${i}.name`);
      next.delete(`m${i}.service`);
      return next;
    });
    setErrorMessage(null);
    // Member edits invalidate prior schedule results.
    setScheduleResult(null);
  }

  /** Move forward to the given step, validating the current one
   *  on the way. Back-navigation (step < current) skips validation
   *  so the user can always retreat. */
  function goToStep(target: Step) {
    if (typeof target === "number" && typeof step === "number" && target < step) {
      setStep(target);
      setStepErrors(new Set());
      setErrorMessage(null);
      return;
    }
    if (step === 1 && target !== 1) {
      // Step 1 has no fields to validate (size is already clamped).
      setStep(target);
      return;
    }
    if (step === 2 && target !== 2) {
      const errs = new Set<string>();
      members.forEach((m, i) => {
        if (m.name.trim().length === 0) errs.add(`m${i}.name`);
        if (!m.serviceId) errs.add(`m${i}.service`);
      });
      if (errs.size > 0) {
        setStepErrors(errs);
        return;
      }
      setStepErrors(new Set());
      setStep(target);
      return;
    }
    if (step === 3 && target !== 3) {
      const errs = new Set<string>();
      if (date.length === 0) errs.add("date");
      if (isSelectedDayClosed) errs.add("closed");
      if (arrivalKind === "specific" && specificTime.length === 0) {
        errs.add("time");
      }
      if (errs.size > 0) {
        setStepErrors(errs);
        return;
      }
      setStepErrors(new Set());
      // Generate arrangements on the way into step 4.
      void runScheduler();
      setStep(target);
      return;
    }
    if (step === 4 && target !== 4) {
      if (
        !scheduleResult ||
        !scheduleResult.ok ||
        scheduleResult.arrangements.length === 0
      ) {
        return;
      }
      setStep(target);
      return;
    }
    if (step === 5 && target !== 5) {
      setStep(target);
      return;
    }
  }

  async function runScheduler() {
    setScheduling(true);
    setScheduleResult(null);
    setSelectedArrangementIdx(0);
    try {
      const res = await loadGroupSmartSchedule({
        shopSlug,
        date,
        arrivalPref,
        members: members.map((m) => ({
          name: m.name.trim(),
          serviceId: m.serviceId,
          preferredStaffId: m.preferredStaffId,
        })),
      });
      setScheduleResult(res);
    } catch (e) {
      console.error("[BookingGroupFlow] scheduler failed", e);
      setScheduleResult({ ok: false, reason: "server_error" });
    } finally {
      setScheduling(false);
    }
  }

  async function onSubmit() {
    if (submitting) return;
    if (
      !scheduleResult ||
      !scheduleResult.ok ||
      !scheduleResult.arrangements[selectedArrangementIdx]
    ) {
      return;
    }
    // P1 #18 — empty-state check first so the user gets the
    // "required" copy rather than the "invalid format" copy.
    if (primaryPhone.trim().length === 0) {
      setErrorMessage(groupCopy.phoneRequired ?? "Vui lòng nhập số điện thoại.");
      return;
    }
    // P1 #18 — format check before the server round-trip. Same
    // helper the server action uses (`validateGuestPhone`) so
    // client + server stay in lockstep.
    if (!validateGuestPhone(primaryPhone).ok) {
      setErrorMessage(
        groupCopy.contactInvalidPhone ??
          "Số điện thoại không hợp lệ.",
      );
      return;
    }
    // P1 #19 — email is optional, but if filled it must be valid.
    const emailTrim = primaryEmail.trim();
    if (emailTrim.length > 0 && !isValidEmailFormat(emailTrim)) {
      setErrorMessage(
        groupCopy.contactInvalidEmail ?? "Email không hợp lệ.",
      );
      return;
    }
    setErrorMessage(null);
    setSubmitting(true);
    try {
      const arr = scheduleResult.arrangements[selectedArrangementIdx];
      // Map per-member assignment → wall-clock HH:MM in salon tz.
      const payload: GroupBookingMember[] = arr.assignments
        .slice()
        .sort((a, b) => a.memberIndex - b.memberIndex)
        .map((a) => {
          const draft = members[a.memberIndex];
          // The scheduler returns UTC ISO; `submitGroupBooking`
          // expects salon-local "HH:MM" (24h). Convert via Intl in
          // the salon's tz so DST is correctly handled (e.g. spring-
          // forward day where wall-clock 02:30 doesn't exist).
          const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: salon.timezone,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).formatToParts(new Date(a.startUtcIso));
          const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
          const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
          const time24 = `${hh}:${mm}`;
          return {
            name: draft.name.trim(),
            phone: primaryPhone,
            email: primaryEmail.trim() || undefined,
            serviceId: draft.serviceId,
            staffId: a.staffId,
            date,
            time: time24,
          };
        });

      const res: GroupBookingResult = await submitGroupBooking({
        shopSlug,
        members: payload,
        idempotencyKey: crypto.randomUUID(),
      });
      if (res.ok) {
        setSuccessResult({ groupId: res.groupId, bookingIds: res.bookingIds });
        setStep("success");
        return;
      }
      if (res.reason === "slot_conflict") {
        // The arrangement we picked just got raced. Re-run the
        // scheduler so the user can pick a fresh option.
        setErrorMessage(
          groupCopy.conflictExternal ??
            "Khung giờ vừa bị đặt mất. Đã tạo lại danh sách lựa chọn.",
        );
        await runScheduler();
        return;
      }
      if (res.reason === "past_date") {
        setErrorMessage(groupCopy.pastDate ?? "Không thể đặt lịch vào ngày đã qua.");
        return;
      }
      if (res.reason === "duplicate_submission") {
        setErrorMessage(groupCopy.duplicateSubmission);
        return;
      }
      if (res.reason === "salon_closed_day") {
        setErrorMessage(groupCopy.salonClosedDay);
        return;
      }
      if (res.reason === "salon_paused") {
        setErrorMessage(groupCopy.salonPaused);
        return;
      }
      if (res.reason === "invalid_group_size") {
        setErrorMessage(groupCopy.invalidGroupSize);
        return;
      }
      // P1 #20 — granular validation reasons. Each carries a 1-indexed
      // `memberNumber` so the copy can pinpoint the problem instead
      // of showing the generic "couldn't book the group" fallback.
      const mn = String(res.memberNumber ?? 1);
      if (res.reason === "invalid_name") {
        setErrorMessage(
          (groupCopy.invalidNameForMember ??
            "Person {n}'s name is missing or invalid.").replace("{n}", mn),
        );
        return;
      }
      if (res.reason === "invalid_phone") {
        setErrorMessage(
          (groupCopy.invalidPhoneForMember ??
            "Person {n}'s phone isn't valid.").replace("{n}", mn),
        );
        return;
      }
      if (res.reason === "invalid_email") {
        setErrorMessage(
          (groupCopy.invalidEmailForMember ??
            "Person {n}'s email isn't valid.").replace("{n}", mn),
        );
        return;
      }
      if (res.reason === "invalid_time") {
        setErrorMessage(
          (groupCopy.invalidTimeForMember ??
            "Person {n}'s time is invalid.").replace("{n}", mn),
        );
        return;
      }
      if (res.reason === "invalid_date") {
        setErrorMessage(
          (groupCopy.invalidDateForMember ??
            "Person {n}'s date is invalid.").replace("{n}", mn),
        );
        return;
      }
      setErrorMessage(groupCopy.serverError);
    } finally {
      setSubmitting(false);
    }
  }

  // Step 4 enters → kick the scheduler if results are missing
  // (e.g. user back-stepped to 3, didn't change anything, forward
  // again — we still want fresh data because availability moves).
  useEffect(() => {
    if (step === 4 && !scheduling && !scheduleResult) {
      void runScheduler();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ── Render ─────────────────────────────────────────────────────
  if (step === "success" && successResult) {
    return (
      <SuccessPanel
        t={t}
        groupCopy={groupCopy}
        successResult={successResult}
        members={members}
        services={services}
        scheduleResult={scheduleResult}
        selectedArrangementIdx={selectedArrangementIdx}
      />
    );
  }

  return (
    <section
      data-testid="booking-group-flow"
      className="mt-8 w-full"
      style={{ color: "var(--booking-text)" }}
    >
      <Stepper
        current={typeof step === "number" ? step : 5}
        labels={[
          groupCopy.groupStep1 ?? "Số người",
          groupCopy.groupStep2 ?? "Dịch vụ",
          groupCopy.groupStep3 ?? "Ngày & giờ",
          groupCopy.groupStep4 ?? "Sắp xếp",
          groupCopy.groupStep5 ?? "Xác nhận",
        ]}
        onJump={(n) => {
          if (n < (typeof step === "number" ? step : 5)) {
            goToStep(n as Step);
          }
        }}
      />

      {step === 1 ? (
        <SizeStep
          t={t}
          groupCopy={groupCopy}
          size={size}
          maxGroupSize={maxGroupSize}
          onApplySize={applySize}
          onNext={() => goToStep(2)}
        />
      ) : null}

      {step === 2 ? (
        <ServiceStaffStep
          t={t}
          groupCopy={groupCopy}
          members={members}
          services={services}
          staff={staff}
          capability={capability}
          duplicateStaffIdx={duplicateStaffIdx}
          stepErrors={stepErrors}
          totalDisplay={totalDisplay}
          maxMinutes={totals.maxMinutes}
          size={size}
          onPatchMember={patchMember}
          onBack={() => goToStep(1)}
          onNext={() => goToStep(3)}
        />
      ) : null}

      {step === 3 ? (
        <DateArrivalStep
          t={t}
          groupCopy={groupCopy}
          date={date}
          dateBounds={dateBounds}
          arrivalKind={arrivalKind}
          specificTime={specificTime}
          isSelectedDayClosed={isSelectedDayClosed}
          stepErrors={stepErrors}
          onDateChange={(v) => {
            setDate(v);
            setStepErrors(new Set());
            setScheduleResult(null);
          }}
          onArrivalKindChange={(k) => {
            setArrivalKind(k);
            setStepErrors(new Set());
            setScheduleResult(null);
          }}
          onSpecificTimeChange={(v) => {
            setSpecificTime(v);
            setScheduleResult(null);
          }}
          onBack={() => goToStep(2)}
          onNext={() => goToStep(4)}
        />
      ) : null}

      {step === 4 ? (
        <ArrangementStep
          t={t}
          groupCopy={groupCopy}
          scheduling={scheduling}
          scheduleResult={scheduleResult}
          selectedIdx={selectedArrangementIdx}
          currencyCode={salon.currencyCode}
          onSelect={setSelectedArrangementIdx}
          onRetry={() => void runScheduler()}
          onBack={() => goToStep(3)}
          onNext={() => goToStep(5)}
        />
      ) : null}

      {step === 5 ? (
        <ConfirmStep
          t={t}
          groupCopy={groupCopy}
          arrangement={
            scheduleResult && scheduleResult.ok
              ? scheduleResult.arrangements[selectedArrangementIdx] ?? null
              : null
          }
          members={members}
          services={services}
          date={date}
          timezone={salon.timezone}
          primaryPhone={primaryPhone}
          primaryEmail={primaryEmail}
          submitting={submitting}
          errorMessage={errorMessage}
          totalDisplay={totalDisplay}
          maxMinutes={totals.maxMinutes}
          size={size}
          onPhoneChange={(v) => setPrimaryPhone(formatPhoneInputProgressive(v))}
          onEmailChange={setPrimaryEmail}
          onBack={() => goToStep(4)}
          onSubmit={() => void onSubmit()}
        />
      ) : null}
    </section>
  );
}

// ─── Stepper ────────────────────────────────────────────────────

function Stepper({
  current,
  labels,
  onJump,
}: {
  current: number;
  labels: readonly string[];
  onJump: (n: number) => void;
}) {
  return (
    <ol
      data-testid="group-stepper"
      aria-label="Group booking steps"
      className="mb-6 flex flex-wrap items-center gap-1.5 text-xs"
    >
      {labels.map((label, idx) => {
        const n = idx + 1;
        const isCurrent = n === current;
        const isPast = n < current;
        const isClickable = isPast;
        const Tag = isClickable ? "button" : "span";
        return (
          <li key={label} className="flex items-center gap-1.5">
            <Tag
              type={isClickable ? "button" : undefined}
              onClick={isClickable ? () => onJump(n) : undefined}
              aria-current={isCurrent ? "step" : undefined}
              data-testid={`group-step-${n}`}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-full px-2.5 font-semibold transition-colors",
                isCurrent
                  ? "bg-[var(--salon-primary)] text-[var(--booking-bg)]"
                  : isPast
                    ? "bg-[var(--booking-bg-card)] text-[var(--booking-text)] hover:bg-[var(--booking-bg-input)]"
                    : "bg-transparent text-[var(--booking-text-muted)]",
              )}
            >
              <span
                className={cn(
                  "flex h-4 w-4 items-center justify-center rounded-full text-[10px]",
                  isCurrent
                    ? "bg-[var(--booking-bg)] text-[var(--salon-primary)]"
                    : isPast
                      ? "bg-[var(--booking-bg-input)] text-[var(--booking-text-muted)]"
                      : "border border-[var(--booking-text-muted)]/40",
                )}
              >
                {n}
              </span>
              <span className="hidden sm:inline">{label}</span>
            </Tag>
            {idx < labels.length - 1 ? (
              <span
                aria-hidden
                className="h-px w-3 bg-[var(--booking-border)] sm:w-5"
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// ─── STEP 1 — Number of people ──────────────────────────────────

function SizeStep({
  t,
  groupCopy,
  size,
  maxGroupSize,
  onApplySize,
  onNext,
}: {
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  size: number;
  maxGroupSize: number;
  onApplySize: (n: number) => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-4" data-testid="group-step-size-panel">
      <h2 className="text-lg font-semibold sm:text-xl">{groupCopy.sizeHeading}</h2>
      <div
        className={cn(
          "grid gap-2",
          maxGroupSize <= 3
            ? "grid-cols-2"
            : maxGroupSize <= 4
              ? "grid-cols-3"
              : "grid-cols-4 sm:grid-cols-5",
        )}
        role="radiogroup"
        aria-label={groupCopy.sizeHeading}
      >
        {Array.from(
          { length: Math.max(0, maxGroupSize - 1) },
          (_, i) => i + 2,
        ).map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={size === n}
            data-testid={`group-size-${n}`}
            onClick={() => onApplySize(n)}
            className={cn(
              "min-h-11 rounded-xl border text-lg font-semibold transition-colors",
              size === n
                ? "border-[var(--salon-primary)] bg-[var(--salon-primary)] text-[var(--booking-bg)]"
                : "border-[var(--booking-border)] bg-[var(--booking-bg-input)]",
            )}
          >
            {n}
          </button>
        ))}
      </div>
      <p className="text-xs text-[var(--booking-text-muted)]">
        {(groupCopy.maxSizeHint ?? "Up to {n} people").replace(
          "{n}",
          String(maxGroupSize),
        )}
      </p>
      <div className="mt-6 flex justify-end">
        <LuxuryBookingCta onClick={onNext} data-testid="group-size-next">
          {t.next}
        </LuxuryBookingCta>
      </div>
    </div>
  );
}

// ─── STEP 2 — Service & Staff per member ────────────────────────

function ServiceStaffStep({
  t,
  groupCopy,
  members,
  services,
  staff,
  capability,
  duplicateStaffIdx,
  stepErrors,
  totalDisplay,
  maxMinutes,
  size,
  onPatchMember,
  onBack,
  onNext,
}: {
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  members: readonly MemberDraft[];
  services: readonly BookingServiceItem[];
  staff: readonly BookingStaffItem[];
  capability: ReturnType<typeof buildCapabilityMap>;
  duplicateStaffIdx: Set<number>;
  stepErrors: Set<string>;
  totalDisplay: string | null;
  maxMinutes: number;
  size: number;
  onPatchMember: (i: number, patch: Partial<MemberDraft>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-4 pb-32" data-testid="group-step-service-panel">
      <h2 className="text-lg font-semibold sm:text-xl">
        {groupCopy.reviewHeading}
      </h2>
      {duplicateStaffIdx.size > 0 ? (
        <p
          role="status"
          data-testid="group-staff-conflict-note"
          className="rounded-xl border border-nq-warning/45 bg-nq-warning/10 px-3 py-2 text-xs"
        >
          {groupCopy.staffConflictNote ??
            "Two people have selected the same staff."}
        </p>
      ) : null}

      <div className="space-y-3">
        {members.map((m, i) => (
          <MemberCard
            key={i}
            index={i}
            t={t}
            groupCopy={groupCopy}
            member={m}
            services={services}
            staff={staff}
            capability={capability}
            isDuplicateStaff={duplicateStaffIdx.has(i)}
            nameError={stepErrors.has(`m${i}.name`)}
            serviceError={stepErrors.has(`m${i}.service`)}
            onChange={(patch) => onPatchMember(i, patch)}
          />
        ))}
      </div>

      <StickyFooter
        leftLabel={groupCopy.totalLabel ?? "Total"}
        leftValue={
          <span>
            {size} {groupCopy.peopleSuffix ?? "people"}
            {totalDisplay ? ` · ${totalDisplay}` : ""}
            {maxMinutes > 0 ? ` · ${maxMinutes} ${t.minuteSuffixShort}` : ""}
          </span>
        }
      >
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          data-testid="group-back"
          className="nq-booking-glass h-11 min-h-11 shrink-0 border border-[var(--booking-border)] bg-transparent text-[var(--booking-text-muted)] shadow-none"
        >
          {t.back}
        </Button>
        <LuxuryBookingCta onClick={onNext} data-testid="group-service-next">
          {t.next}
        </LuxuryBookingCta>
      </StickyFooter>
    </div>
  );
}

function MemberCard({
  index,
  t,
  groupCopy,
  member,
  services,
  staff,
  capability,
  isDuplicateStaff,
  nameError,
  serviceError,
  onChange,
}: {
  index: number;
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  member: MemberDraft;
  services: readonly BookingServiceItem[];
  staff: readonly BookingStaffItem[];
  capability: ReturnType<typeof buildCapabilityMap>;
  isDuplicateStaff: boolean;
  nameError: boolean;
  serviceError: boolean;
  onChange: (patch: Partial<MemberDraft>) => void;
}) {
  const eligibleStaff = useMemo(() => {
    if (!member.serviceId) return staff;
    return filterStaffCapableForService(staff, capability, member.serviceId);
  }, [staff, capability, member.serviceId]);

  return (
    <div
      data-testid={`group-member-${index}`}
      className={cn(
        "rounded-2xl border bg-[var(--booking-bg-card)] p-4 sm:p-5",
        isDuplicateStaff
          ? "border-nq-warning/60 ring-1 ring-nq-warning/30"
          : "border-[var(--booking-border)]",
      )}
    >
      <h3 className="mb-3 text-base font-semibold">
        {groupCopy.personLabel.replace("{n}", String(index + 1))}
      </h3>

      <div className="space-y-3">
        <div>
          <input
            id={`group-member-${index}-name-input`}
            type="text"
            autoComplete="name"
            placeholder={t.clientNameLabel}
            value={member.name}
            maxLength={100}
            aria-invalid={nameError || undefined}
            onChange={(e) => onChange({ name: e.target.value })}
            className={cn(
              "nq-booking-field",
              member.name.trim().length > 0 &&
                "font-medium text-[var(--booking-text)]",
              nameError && "border-nq-error/50",
            )}
            data-testid={`group-member-${index}-name`}
          />
          {nameError ? (
            <p role="alert" className="mt-1 text-xs text-nq-error">
              {t.bookingErrors.nameRequired}
            </p>
          ) : null}
        </div>

        <div>
          <select
            id={`group-member-${index}-service-input`}
            value={member.serviceId}
            aria-invalid={serviceError || undefined}
            onChange={(e) => onChange({ serviceId: e.target.value })}
            className={cn(
              "nq-booking-field",
              serviceError && "border-nq-error/50",
            )}
            data-testid={`group-member-${index}-service`}
            style={{
              color: member.serviceId
                ? "var(--booking-text)"
                : "var(--booking-text-muted)",
            }}
          >
            <option value="">— {t.breadcrumbServices} —</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.totalMinutes} {t.minuteSuffixShort}
                {s.priceDisplay ? ` · ${s.priceDisplay}` : ""}
              </option>
            ))}
          </select>
          {serviceError ? (
            <p role="alert" className="mt-1 text-xs text-nq-error">
              {t.bookingErrors.serviceRequired}
            </p>
          ) : null}
        </div>

        <div>
          <select
            id={`group-member-${index}-staff-input`}
            value={member.preferredStaffId ?? ""}
            onChange={(e) =>
              onChange({ preferredStaffId: e.target.value || null })
            }
            className="nq-booking-field"
            data-testid={`group-member-${index}-staff`}
            style={{
              color: member.preferredStaffId
                ? "var(--booking-text)"
                : "var(--booking-text-muted)",
            }}
          >
            <option value="">— {t.anyStaffOptionTitle} —</option>
            {eligibleStaff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {isDuplicateStaff ? (
            <p
              role="alert"
              className="mt-1 text-xs text-nq-warning"
              data-testid={`group-member-${index}-duplicate-staff`}
            >
              {groupCopy.staffConflictNote ??
                "Two people have selected the same staff."}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── STEP 3 — Date & Arrival window ──────────────────────────────

function DateArrivalStep({
  t,
  groupCopy,
  date,
  dateBounds,
  arrivalKind,
  specificTime,
  isSelectedDayClosed,
  stepErrors,
  onDateChange,
  onArrivalKindChange,
  onSpecificTimeChange,
  onBack,
  onNext,
}: {
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  date: string;
  dateBounds: { min: string; max: string };
  arrivalKind: GroupArrivalPreference["kind"];
  specificTime: string;
  isSelectedDayClosed: boolean;
  stepErrors: Set<string>;
  onDateChange: (v: string) => void;
  onArrivalKindChange: (k: GroupArrivalPreference["kind"]) => void;
  onSpecificTimeChange: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-5 pb-32" data-testid="group-step-date-panel">
      <h2 className="text-lg font-semibold sm:text-xl">
        {t.stepDateHeading}
      </h2>
      <div>
        <label
          className="mb-1 block text-xs font-medium text-[var(--booking-text-muted)]"
          htmlFor="group-date"
        >
          {t.breadcrumbDate}
        </label>
        <input
          id="group-date"
          type="date"
          value={date}
          min={dateBounds.min}
          max={dateBounds.max}
          onChange={(e) => onDateChange(e.target.value)}
          aria-invalid={stepErrors.has("date") || undefined}
          className={cn(
            "nq-booking-field",
            stepErrors.has("date") && "border-nq-error/50",
          )}
          data-testid="group-date-input"
        />
        {isSelectedDayClosed ? (
          <p
            role="alert"
            data-testid="group-date-closed"
            className="mt-2 rounded-lg border border-nq-warning/45 bg-nq-warning/10 px-3 py-2 text-xs font-semibold"
          >
            {groupCopy.schedulingClosed ??
              "Salon is closed on this date. Please pick another date."}
          </p>
        ) : null}
        {stepErrors.has("date") && !isSelectedDayClosed ? (
          <p role="alert" className="mt-1 text-xs text-nq-error">
            {groupCopy.sharedScheduleRequired ?? "Please pick a date."}
          </p>
        ) : null}
      </div>

      <fieldset>
        <legend className="mb-2 block text-base font-semibold">
          {groupCopy.arrivalQuestion ?? "When would you like to arrive?"}
        </legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {ARRIVAL_PRESETS.map((k) => {
            const label =
              k === "morning"
                ? groupCopy.arrivalMorning ?? "Morning"
                : k === "afternoon"
                  ? groupCopy.arrivalAfternoon ?? "Afternoon"
                  : groupCopy.arrivalEvening ?? "Evening";
            const emoji =
              k === "morning" ? "🌅" : k === "afternoon" ? "☀️" : "🌆";
            const active = arrivalKind === k;
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`group-arrival-${k}`}
                onClick={() => onArrivalKindChange(k)}
                className={cn(
                  "min-h-12 rounded-xl border px-4 py-2 text-left text-sm font-medium transition-colors",
                  active
                    ? "border-[var(--salon-primary)] bg-[var(--salon-primary)]/10 text-[var(--booking-text)]"
                    : "border-[var(--booking-border)] bg-[var(--booking-bg-input)] text-[var(--booking-text-muted)]",
                )}
              >
                <span className="mr-2" aria-hidden>
                  {emoji}
                </span>
                {label}
              </button>
            );
          })}
          <button
            type="button"
            role="radio"
            aria-checked={arrivalKind === "specific"}
            data-testid="group-arrival-specific"
            onClick={() => onArrivalKindChange("specific")}
            className={cn(
              "min-h-12 rounded-xl border px-4 py-2 text-left text-sm font-medium transition-colors sm:col-span-2",
              arrivalKind === "specific"
                ? "border-[var(--salon-primary)] bg-[var(--salon-primary)]/10 text-[var(--booking-text)]"
                : "border-[var(--booking-border)] bg-[var(--booking-bg-input)] text-[var(--booking-text-muted)]",
            )}
          >
            <span className="mr-2" aria-hidden>
              🕐
            </span>
            {groupCopy.arrivalSpecific ?? "Specific time"}
          </button>
        </div>
        {arrivalKind === "specific" ? (
          <div className="mt-3">
            <input
              type="time"
              step={300}
              value={specificTime}
              aria-invalid={stepErrors.has("time") || undefined}
              onChange={(e) => onSpecificTimeChange(e.target.value)}
              className={cn(
                "nq-booking-field tabular-nums",
                stepErrors.has("time") && "border-nq-error/50",
              )}
              data-testid="group-specific-time"
            />
            {stepErrors.has("time") ? (
              <p role="alert" className="mt-1 text-xs text-nq-error">
                {groupCopy.sharedScheduleRequired ?? "Please pick a time."}
              </p>
            ) : null}
          </div>
        ) : null}
      </fieldset>

      <StickyFooter leftLabel={null} leftValue={null}>
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          data-testid="group-back"
          className="nq-booking-glass h-11 min-h-11 shrink-0 border border-[var(--booking-border)] bg-transparent text-[var(--booking-text-muted)] shadow-none"
        >
          {t.back}
        </Button>
        <LuxuryBookingCta
          onClick={onNext}
          disabled={isSelectedDayClosed}
          data-testid="group-date-next"
        >
          {t.next}
        </LuxuryBookingCta>
      </StickyFooter>
    </div>
  );
}

// ─── STEP 4 — AI Arrangement ─────────────────────────────────────

function ArrangementStep({
  t,
  groupCopy,
  scheduling,
  scheduleResult,
  selectedIdx,
  currencyCode,
  onSelect,
  onRetry,
  onBack,
  onNext,
}: {
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  scheduling: boolean;
  scheduleResult: GroupSmartScheduleResult | null;
  selectedIdx: number;
  currencyCode: BookingSalonMeta["currencyCode"];
  onSelect: (i: number) => void;
  onRetry: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-4 pb-32" data-testid="group-step-arrangement-panel">
      <h2 className="text-lg font-semibold sm:text-xl">
        {groupCopy.groupStep4 ?? "AI Arrangement"}
      </h2>

      {scheduling ? (
        <div
          role="status"
          data-testid="group-scheduling-loading"
          className="rounded-xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] px-4 py-8 text-center text-sm text-[var(--booking-text-muted)]"
        >
          {groupCopy.availabilityChecking ?? "Đang tính lịch tối ưu…"}
        </div>
      ) : null}

      {!scheduling && scheduleResult && !scheduleResult.ok ? (
        <EmptyState
          reason={scheduleResult.reason}
          groupCopy={groupCopy}
          onRetry={onRetry}
          onBack={onBack}
        />
      ) : null}

      {!scheduling && scheduleResult?.ok ? (
        <div className="space-y-3">
          {scheduleResult.arrangements.map((arr, idx) => (
            <ArrangementCard
              key={`${arr.kind}-${idx}`}
              t={t}
              groupCopy={groupCopy}
              arrangement={arr}
              currencyCode={currencyCode}
              selected={idx === selectedIdx}
              onSelect={() => onSelect(idx)}
            />
          ))}
        </div>
      ) : null}

      <StickyFooter leftLabel={null} leftValue={null}>
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          data-testid="group-back"
          className="nq-booking-glass h-11 min-h-11 shrink-0 border border-[var(--booking-border)] bg-transparent text-[var(--booking-text-muted)] shadow-none"
        >
          {t.back}
        </Button>
        <LuxuryBookingCta
          onClick={onNext}
          disabled={
            !scheduleResult ||
            !scheduleResult.ok ||
            scheduleResult.arrangements.length === 0
          }
          data-testid="group-arrangement-next"
        >
          {t.next}
        </LuxuryBookingCta>
      </StickyFooter>
    </div>
  );
}

function ArrangementCard({
  t,
  groupCopy,
  arrangement,
  currencyCode,
  selected,
  onSelect,
}: {
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  arrangement: GroupArrangement;
  currencyCode: BookingSalonMeta["currencyCode"];
  selected: boolean;
  onSelect: () => void;
}) {
  const heading =
    arrangement.kind === "best"
      ? groupCopy.schedulingBest ?? "Best ✨"
      : arrangement.kind === "alternative"
        ? groupCopy.schedulingAlt ?? "Alternative"
        : groupCopy.schedulingEarly ?? "Earliest";
  const icon =
    arrangement.kind === "best"
      ? "✨"
      : arrangement.kind === "alternative"
        ? "🔄"
        : "⚡";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-testid={`group-arrangement-${arrangement.kind}`}
      className={cn(
        "block w-full rounded-2xl border p-4 text-left transition-colors sm:p-5",
        selected
          ? "border-[var(--salon-primary)] bg-[var(--salon-primary)]/5 shadow-[var(--shadow-nq-tile-selected)]"
          : "border-[var(--booking-border)] bg-[var(--booking-bg-card)] hover:border-[var(--booking-text-muted)]/40",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">
          <span aria-hidden className="mr-1.5">
            {icon}
          </span>
          {heading}
        </span>
        {arrangement.kind === "best" ? (
          <span className="rounded-full bg-[var(--salon-primary)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--booking-bg)]">
            {groupCopy.schedulingRecommended ?? "Recommended"}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-[var(--booking-text-muted)]">
        {arrangement.groupStartDisplay} → {arrangement.groupEndDisplay}
      </p>
      <ul className="mt-3 space-y-1.5 text-sm">
        {arrangement.assignments.map((a) => (
          <li
            key={a.memberIndex}
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
          >
            <span className="font-medium">
              {a.memberName || `#${a.memberIndex + 1}`}
            </span>
            <span className="text-[var(--booking-text-muted)]">
              {a.startDisplay} · {a.staffName} · {a.serviceName}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-[var(--booking-text-muted)]">
        {(groupCopy.schedulingFinish ?? "Finishes at {time}").replace(
          "{time}",
          arrangement.groupEndDisplay,
        )}
      </p>
      {/* Hide currency from the card if any member is unpriced. */}
      {arrangement.totalCents != null ? (
        <p className="mt-1 text-xs text-[var(--booking-text-muted)]">
          {t.summaryTotal}:{" "}
          {formatCurrency(arrangement.totalCents, currencyCode) ?? ""}
        </p>
      ) : null}
    </button>
  );
}

function EmptyState({
  reason,
  groupCopy,
  onRetry,
  onBack,
}: {
  reason: Exclude<GroupSmartScheduleResult, { ok: true }>["reason"];
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  onRetry: () => void;
  onBack: () => void;
}) {
  const copy =
    reason === "salon_closed"
      ? groupCopy.schedulingClosed ??
        "Salon is closed on this date. Please pick another date."
      : reason === "no_slots"
        ? groupCopy.schedulingNoSlots ??
          "No slots available in that window. Try a different time or date."
        : reason === "salon_paused"
          ? groupCopy.salonPaused
          : groupCopy.serverError;
  return (
    <div
      role="alert"
      data-testid="group-scheduling-empty"
      data-reason={reason}
      className="rounded-xl border border-nq-warning/45 bg-nq-warning/10 px-4 py-5 text-sm"
    >
      <p>{copy}</p>
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          className="h-9 min-h-9 rounded-full border border-[var(--booking-border)] bg-transparent px-3 text-xs"
        >
          {groupCopy.schedulingTryDate ?? "Try another date"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={onRetry}
          className="h-9 min-h-9 rounded-full border border-[var(--booking-border)] bg-transparent px-3 text-xs"
        >
          Retry
        </Button>
      </div>
    </div>
  );
}

// ─── STEP 5 — Confirm ────────────────────────────────────────────

function ConfirmStep({
  t,
  groupCopy,
  arrangement,
  members,
  services,
  date,
  timezone,
  primaryPhone,
  primaryEmail,
  submitting,
  errorMessage,
  totalDisplay,
  maxMinutes,
  size,
  onPhoneChange,
  onEmailChange,
  onBack,
  onSubmit,
}: {
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  arrangement: GroupArrangement | null;
  members: readonly MemberDraft[];
  services: readonly BookingServiceItem[];
  date: string;
  timezone: string;
  primaryPhone: string;
  primaryEmail: string;
  submitting: boolean;
  errorMessage: string | null;
  totalDisplay: string | null;
  maxMinutes: number;
  size: number;
  onPhoneChange: (v: string) => void;
  onEmailChange: (v: string) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const dateDisplay = useMemo(() => {
    // Display the chosen date in salon-tz long form. The
    // arrangement carries UTC ISO; reuse formatInSalonTz for
    // consistency with the per-row times.
    const firstStart = arrangement?.assignments[0]?.startUtcIso;
    if (!firstStart) return date;
    return formatInSalonTz(firstStart, timezone, "date");
  }, [arrangement, date, timezone]);

  if (!arrangement) {
    return (
      <p
        role="alert"
        className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
      >
        {groupCopy.schedulingNoSlots ?? "Please pick an arrangement first."}
      </p>
    );
  }

  return (
    <div className="space-y-4 pb-32" data-testid="group-step-confirm-panel">
      <h2 className="text-lg font-semibold sm:text-xl">
        {t.stepConfirmHeading}
      </h2>

      <div className="rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4 sm:p-5">
        <p className="text-xs text-[var(--booking-text-muted)]">
          {dateDisplay}
        </p>
        <ul className="mt-3 space-y-2 text-sm">
          {arrangement.assignments.map((a) => {
            const draft = members[a.memberIndex];
            const svc = services.find((s) => s.id === draft?.serviceId);
            return (
              <li
                key={a.memberIndex}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-[var(--booking-border)]/60 pb-2 last:border-b-0 last:pb-0"
              >
                <span className="font-medium">{draft?.name || "—"}</span>
                <span className="text-[var(--booking-text-muted)]">
                  {a.startDisplay} · {a.staffName} ·{" "}
                  {svc?.name ?? a.serviceName}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-3">
        <h3 className="text-base font-semibold">
          {groupCopy.primaryContactHeading}
        </h3>
        <p className="text-xs text-[var(--booking-text-muted)]">
          {groupCopy.primaryContactHint}
        </p>
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          data-testid="group-primary-phone"
          value={primaryPhone}
          maxLength={24}
          placeholder={t.clientPhonePlaceholder}
          onChange={(e) => onPhoneChange(e.target.value)}
          className="nq-booking-field"
        />
        <input
          type="email"
          autoComplete="email"
          data-testid="group-primary-email"
          value={primaryEmail}
          placeholder={t.clientEmailLabel}
          onChange={(e) => onEmailChange(e.target.value)}
          className="nq-booking-field"
        />
      </div>

      {errorMessage ? (
        <p
          role="alert"
          data-testid="group-error"
          className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
        >
          {errorMessage}
        </p>
      ) : null}

      <StickyFooter
        leftLabel={groupCopy.groupTotal ?? groupCopy.totalLabel ?? "Total"}
        leftValue={
          <span>
            {size} {groupCopy.peopleSuffix ?? "people"}
            {totalDisplay ? ` · ${totalDisplay}` : ""}
            {maxMinutes > 0 ? ` · ${maxMinutes} ${t.minuteSuffixShort}` : ""}
          </span>
        }
      >
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          data-testid="group-back"
          className="nq-booking-glass h-11 min-h-11 shrink-0 border border-[var(--booking-border)] bg-transparent text-[var(--booking-text-muted)] shadow-none"
        >
          {t.back}
        </Button>
        <LuxuryBookingCta
          onClick={onSubmit}
          disabled={submitting}
          data-testid="group-confirm"
        >
          {submitting ? groupCopy.submittingGroup : groupCopy.confirmGroup}
        </LuxuryBookingCta>
      </StickyFooter>
    </div>
  );
}

// ─── Success ─────────────────────────────────────────────────────

function SuccessPanel({
  t,
  groupCopy,
  successResult,
  members,
  services,
  scheduleResult,
  selectedArrangementIdx,
}: {
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  successResult: { groupId: string; bookingIds: string[] };
  members: readonly MemberDraft[];
  services: readonly BookingServiceItem[];
  scheduleResult: GroupSmartScheduleResult | null;
  selectedArrangementIdx: number;
}) {
  const arrangement =
    scheduleResult && scheduleResult.ok
      ? scheduleResult.arrangements[selectedArrangementIdx]
      : null;
  return (
    <section
      data-testid="booking-group-success"
      className="mt-8 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-6 text-center"
      style={{ color: "var(--booking-text)" }}
    >
      <h2 className="text-xl font-semibold sm:text-2xl">
        {groupCopy.groupSuccess ?? groupCopy.successHeading}
      </h2>
      <p className="mt-2 text-sm text-[var(--booking-text-muted)]">
        {(groupCopy.groupRef ?? "Reference") + " #"}
        {successResult.groupId.slice(0, 8).toUpperCase()}
      </p>
      {arrangement ? (
        <ul className="mt-5 space-y-2 text-left text-sm">
          {arrangement.assignments.map((a) => {
            const draft = members[a.memberIndex];
            const svc = services.find((s) => s.id === draft?.serviceId);
            return (
              <li
                key={a.memberIndex}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--booking-border)] pb-2"
              >
                <span className="font-semibold">{draft?.name}</span>
                <span className="text-[var(--booking-text-muted)]">
                  {a.startDisplay} · {svc?.name ?? a.serviceName} · {a.staffName}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {t ? null : null}
    </section>
  );
}

// ─── Sticky footer (shared) ──────────────────────────────────────

function StickyFooter({
  leftLabel,
  leftValue,
  children,
}: {
  leftLabel: string | null;
  leftValue: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--booking-border)] bg-[var(--booking-bg)] px-4 py-3 backdrop-blur"
      data-testid="group-sticky-footer"
    >
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {leftLabel != null || leftValue != null ? (
          <div className="text-sm" data-testid="group-total-preview">
            {leftLabel != null ? (
              <span className="text-[var(--booking-text-muted)]">
                {leftLabel}:{" "}
              </span>
            ) : null}
            <span className="font-semibold">{leftValue}</span>
          </div>
        ) : (
          <span aria-hidden />
        )}
        <div className="flex gap-2">{children}</div>
      </div>
    </div>
  );
}
