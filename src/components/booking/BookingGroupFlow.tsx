"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type {
  BookingSalonMeta,
  BookingStaffItem,
} from "@/shared/booking/loadBookingServices";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import {
  submitGroupBooking,
  type GroupBookingMember,
  type GroupBookingResult,
} from "@/shared/booking/submitGroupBooking";
import { formatCurrency } from "@/shared/lib/currencyFormat";
import { formatPhoneInputProgressive } from "@/shared/lib/phoneFormat";
import { salonDayRangeUtc, salonWallTimeToUtcIso } from "@/shared/lib/salonTime";
import { createClient } from "@/shared/lib/supabase/client";
import { cn } from "@/shared/lib/cn";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import { Button } from "@/components/ui/Button";

/**
 * Group booking flow — QA-revised after the round-2 report (12/05/2026).
 *
 * Key model change from PR #140 (P0.G2): the group now picks ONE shared
 * date + ONE shared time at the top. Each member only chooses their
 * own name + service + staff. The real-world use case is "friends /
 * family / wedding party come together at the same time" — per-member
 * pickers were forcing the wrong mental model.
 *
 * Other QA fixes layered in:
 *   - P0.G1: submit is always enabled; click validates each member
 *            field with inline errors instead of silent disable.
 *   - P0.G3: step 2 heading renamed from "Xem lại lịch nhóm" to
 *            the data-entry-accurate "Đặt lịch cho từng người".
 *   - P1.G1: sticky primary-contact summary at the top of step 2.
 *   - P1.G5: group size selector extended 2–4 → 2–8.
 *   - P1.G7: same-staff-twice in a shared-time group is now flagged
 *            inline on the second occurrence before submit.
 *   - P1.G8: sticky total (sum of prices + max duration) above the
 *            confirm button.
 *
 * Deferred to follow-up (flagged in PR #142 body):
 *   - Group-specific stepper (cosmetic)
 *   - Replacing native date/time inputs with the visual calendar +
 *     filtered slot grid (substantial scope)
 *   - Receptionist-side group walk-in flow
 */

type BookingGroupFlowProps = {
  t: BookingMessages;
  shopSlug: string;
  services: readonly BookingServiceItem[];
  staff: readonly BookingStaffItem[];
  salon: BookingSalonMeta;
  /** Upper bound on group size, derived from active-staff count in
   * the parent (`Math.min(activeStaff, HARD_GROUP_CAP)`). Drives the
   * size pill grid + clamps `applySize`. The DB function still
   * accepts up to 8 — this is a salon-specific UX cap, not a
   * security boundary. */
  maxGroupSize: number;
};

type MemberDraft = {
  name: string;
  serviceId: string;
  staffId: string;
};

type MemberFieldError = "name" | "service" | "staff";

function blankMember(): MemberDraft {
  return { name: "", serviceId: "", staffId: "" };
}

type Step = "size" | "members" | "success";

export function BookingGroupFlow({
  t,
  shopSlug,
  services,
  staff,
  salon,
  maxGroupSize,
}: BookingGroupFlowProps) {
  const [step, setStep] = useState<Step>("size");
  const [size, setSize] = useState<number>(2);
  const [primaryPhone, setPrimaryPhone] = useState("");
  const [primaryEmail, setPrimaryEmail] = useState("");
  // P0.G2 — shared date + time across the whole group.
  const [sharedDate, setSharedDate] = useState("");
  const [sharedTime, setSharedTime] = useState("");
  const [members, setMembers] = useState<MemberDraft[]>(() => [
    blankMember(),
    blankMember(),
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [conflictIdx, setConflictIdx] = useState<Set<number>>(() => new Set());
  // P0.G1 — explicit per-field error state, set on submit-click.
  const [memberErrors, setMemberErrors] = useState<
    Map<number, Set<MemberFieldError>>
  >(() => new Map());
  const [scheduleErrors, setScheduleErrors] = useState<Set<"date" | "time">>(
    () => new Set(),
  );
  const [contactPhoneError, setContactPhoneError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<{
    groupId: string;
    bookingIds: string[];
  } | null>(null);
  const firstErrorRef = useRef<HTMLElement | null>(null);

  // Defensive — see PR #141 note: an older cached bundle without
  // `groupBooking` would crash inside the error boundary.
  const groupCopy = (t.groupBooking ?? {
    entryTitle: "How would you like to book?",
    individual: "Individual",
    group: "Group 👥",
    sizeHeading: "How many people?",
    personLabel: "Person {n}",
    primaryContactHeading: "Primary contact",
    primaryContactHint:
      "We'll send the confirmation to this phone. Each person can add their own phone below if they want their own reminder.",
    reviewHeading: "Booking details per person",
    confirmGroup: "Confirm group booking",
    submittingGroup: "Booking your group…",
    successHeading: "Group booking confirmed! 🎉",
    successSubtitle: "Reference #{id}",
    conflictMember: "Conflict for Person {n}",
    conflictBanner: "{n} slots are no longer available.",
    duplicateSubmission: "This group was already booked.",
    salonClosedDay: "Salon is closed that day.",
    salonPaused: "Booking is paused.",
    invalidGroupSize: "Group size must be 2–8.",
    serverError: "Couldn't book the group. Try again.",
    addPerson: "Add person",
    removePerson: "Remove",
    groupIconLabel: "Group",
    groupContextHeading: "Group members",
    cancelEntireGroup: "Cancel entire group",
    cancelEntireGroupConfirm: "Cancel every booking in this group?",
  }) as NonNullable<BookingMessages["groupBooking"]>;

  // P1.G7 — same staff picked twice = inline conflict on the
  // SECOND occurrence. Shared time means same-staff is unavoidable
  // overlap, so we can flag it without computing intervals.
  const duplicateStaffIdx = useMemo(() => {
    const seen = new Map<string, number>();
    const dupes = new Set<number>();
    for (let i = 0; i < members.length; i++) {
      const sid = members[i].staffId;
      if (!sid) continue;
      if (seen.has(sid)) dupes.add(i);
      else seen.set(sid, i);
    }
    return dupes;
  }, [members]);

  // P1.G8 — totals across the group.
  const totals = useMemo(() => {
    let totalCents = 0;
    let hasAnyPrice = false;
    let maxMinutes = 0;
    for (const m of members) {
      const svc = services.find((s) => s.id === m.serviceId);
      if (!svc) continue;
      if (svc.priceCents != null) {
        hasAnyPrice = true;
        totalCents += svc.priceCents;
      }
      if (svc.totalMinutes > maxMinutes) maxMinutes = svc.totalMinutes;
    }
    return { totalCents: hasAnyPrice ? totalCents : null, maxMinutes };
  }, [members, services]);

  const totalDisplay = useMemo(() => {
    if (totals.totalCents == null) return null;
    return formatCurrency(totals.totalCents, salon.currencyCode) ?? null;
  }, [totals, salon.currencyCode]);

  // QA STEP 4 — real-time availability check.
  //
  // When the customer has picked a shared date + time AND at least
  // one member has a service, we want to surface "X staff are free
  // at this time" before they submit. Reuses the existing
  // `public_booking_occupancy_for_range` RPC (same endpoint single
  // bookings use). Conservative window = [shared start, shared
  // start + longest selected service duration]; any staff with ANY
  // overlap in that range counts as busy.
  //
  // Debounced 400 ms because the native time input fires onChange
  // per keystroke (typing "10" → "1" then "10"). Without debounce
  // we'd thrash the RPC.
  const [availability, setAvailability] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; availableCount: number; totalActiveStaff: number }
    | { kind: "error" }
  >({ kind: "idle" });
  const availabilitySeqRef = useRef(0);

  // Longest duration among MEMBERS WITH a selected service. If no
  // member has picked a service yet, returns 0 → skip the check.
  const longestSelectedDurationMin = useMemo(() => {
    let max = 0;
    for (const m of members) {
      const svc = services.find((s) => s.id === m.serviceId);
      if (!svc) continue;
      if (svc.totalMinutes > max) max = svc.totalMinutes;
    }
    return max;
  }, [members, services]);

  const totalActiveStaff = staff.length;

  useEffect(() => {
    if (
      sharedDate.length === 0 ||
      sharedTime.length === 0 ||
      longestSelectedDurationMin === 0
    ) {
      setAvailability({ kind: "idle" });
      return;
    }
    const seq = ++availabilitySeqRef.current;
    setAvailability({ kind: "loading" });
    const timer = window.setTimeout(async () => {
      try {
        // Parse HH:MM client-side; reuse the same DST-safe helper
        // single bookings + the server action use.
        const [hStr, miStr] = sharedTime.split(":");
        const h = Number.parseInt(hStr ?? "", 10);
        const mi = Number.parseInt(miStr ?? "", 10);
        if (!Number.isFinite(h) || !Number.isFinite(mi)) {
          if (seq === availabilitySeqRef.current)
            setAvailability({ kind: "idle" });
          return;
        }
        const startUtcIso = salonWallTimeToUtcIso(
          sharedDate,
          h * 60 + mi,
          salon.timezone,
        );
        const startMs = Date.parse(startUtcIso);
        const endMs = startMs + longestSelectedDurationMin * 60_000;
        const { startUtc, endUtc } = salonDayRangeUtc(
          sharedDate,
          salon.timezone,
        );
        const supabase = createClient();
        const { data, error } = await supabase.rpc(
          "public_booking_occupancy_for_range",
          { p_salon_id: salon.id, p_start: startUtc, p_end: endUtc },
        );
        if (seq !== availabilitySeqRef.current) return;
        if (error) {
          setAvailability({ kind: "error" });
          return;
        }
        const rows = (data ?? []) as Array<{
          staff_id: string;
          start_time_utc: string;
          end_time_utc: string;
        }>;
        const busyStaff = new Set<string>();
        for (const r of rows) {
          if (!r.staff_id) continue;
          const rStart = Date.parse(r.start_time_utc);
          const rEnd = Date.parse(r.end_time_utc);
          if (!Number.isFinite(rStart) || !Number.isFinite(rEnd)) continue;
          if (intervalsOverlapMs(startMs, endMs, rStart, rEnd)) {
            busyStaff.add(String(r.staff_id));
          }
        }
        const availableCount = Math.max(0, totalActiveStaff - busyStaff.size);
        setAvailability({
          kind: "ready",
          availableCount,
          totalActiveStaff,
        });
      } catch (e) {
        if (seq !== availabilitySeqRef.current) return;
        console.error("[BookingGroupFlow] availability check", e);
        setAvailability({ kind: "error" });
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    sharedDate,
    sharedTime,
    longestSelectedDurationMin,
    salon.id,
    salon.timezone,
    totalActiveStaff,
  ]);

  // Group is too big for the salon at the chosen time. Surface a
  // warning above the schedule card so it can't be missed.
  const insufficientCapacity =
    availability.kind === "ready" && availability.availableCount < size;

  const sizeNextEnabled = primaryPhone.trim().length > 0;

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
  }

  function patchMember(i: number, patch: Partial<MemberDraft>) {
    setMembers((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], ...patch };
      return next;
    });
    // Clear per-member conflict highlight + field errors once the
    // user touches anything on that card. Encourages re-validation.
    setConflictIdx((prev) => {
      if (!prev.has(i)) return prev;
      const next = new Set(prev);
      next.delete(i);
      return next;
    });
    setMemberErrors((prev) => {
      if (!prev.has(i)) return prev;
      const next = new Map(prev);
      next.delete(i);
      return next;
    });
    setErrorMessage(null);
  }

  function validate(): boolean {
    const newMemberErrors = new Map<number, Set<MemberFieldError>>();
    const newScheduleErrors = new Set<"date" | "time">();
    if (sharedDate.length === 0) newScheduleErrors.add("date");
    if (sharedTime.length === 0) newScheduleErrors.add("time");
    members.forEach((m, i) => {
      const fields = new Set<MemberFieldError>();
      if (m.name.trim().length === 0) fields.add("name");
      if (!m.serviceId) fields.add("service");
      if (!m.staffId) fields.add("staff");
      if (fields.size > 0) newMemberErrors.set(i, fields);
    });
    setScheduleErrors(newScheduleErrors);
    setMemberErrors(newMemberErrors);
    if (newScheduleErrors.size > 0 || newMemberErrors.size > 0) {
      // P0.G1 — scroll the first invalid field into view.
      queueMicrotask(() => {
        firstErrorRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      });
      return false;
    }
    // P1.G7 — same staff twice is a structural conflict in a
    // shared-time group; the DB would catch it too, but better UX
    // to refuse client-side.
    if (duplicateStaffIdx.size > 0) {
      setErrorMessage(
        groupCopy.conflictBanner.replace("{n}", String(duplicateStaffIdx.size)),
      );
      return false;
    }
    return true;
  }

  async function onSubmit() {
    if (submitting) return;
    setErrorMessage(null);
    setConflictIdx(new Set());
    if (!validate()) return;
    // QA STEP 4 — block submit on insufficient capacity. The DB
    // catches this anyway (per-staff slot would conflict), but
    // refusing client-side gives the cleanest error path.
    if (insufficientCapacity && availability.kind === "ready") {
      setErrorMessage(
        (groupCopy.insufficientCapacity ??
          "Chỉ còn {n} thợ rảnh vào thời điểm này. Vui lòng chọn giờ khác hoặc giảm số người.")
          .replace("{n}", String(availability.availableCount)),
      );
      return;
    }

    setSubmitting(true);
    try {
      const payload: GroupBookingMember[] = members.map((m) => ({
        name: m.name,
        phone: primaryPhone,
        email: primaryEmail.trim() || undefined,
        serviceId: m.serviceId,
        staffId: m.staffId,
        date: sharedDate,
        time: sharedTime,
      }));
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
        setConflictIdx(new Set(res.conflictingMembers));
        setErrorMessage(
          res.conflictingMembers.length > 0
            ? groupCopy.conflictBanner.replace(
                "{n}",
                String(res.conflictingMembers.length),
              )
            : t.bookingErrors.slotJustTaken,
        );
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
      setErrorMessage(groupCopy.serverError);
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "success" && successResult) {
    return (
      <section
        data-testid="booking-group-success"
        className="mt-8 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-6 text-center"
        style={{ color: "var(--booking-text)" }}
      >
        <h2 className="text-xl font-semibold sm:text-2xl">
          {groupCopy.successHeading}
        </h2>
        <p className="mt-2 text-sm text-[var(--booking-text-muted)]">
          {groupCopy.successSubtitle.replace(
            "{id}",
            successResult.groupId.slice(0, 8).toUpperCase(),
          )}
        </p>
        <ul className="mt-5 space-y-2 text-left text-sm">
          {members.map((m, i) => {
            const svc = services.find((s) => s.id === m.serviceId);
            const st = staff.find((x) => x.id === m.staffId);
            return (
              <li
                key={i}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--booking-border)] pb-2"
              >
                <span className="font-semibold">{m.name}</span>
                <span className="text-[var(--booking-text-muted)]">
                  {svc?.name} · {st?.name}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-sm text-[var(--booking-text-muted)]">
          {sharedDate} {sharedTime}
        </p>
      </section>
    );
  }

  return (
    <section
      data-testid="booking-group-flow"
      className="mt-8 w-full"
      style={{ color: "var(--booking-text)" }}
    >
      {step === "size" ? (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold sm:text-xl">
            {groupCopy.sizeHeading}
          </h2>
          {/* QA round-2 — size options are dynamic now: 2…maxGroupSize
              where maxGroupSize = min(activeStaffCount, 6). A salon
              with 3 active stylists shows pills [2, 3]; a salon with
              ≥6 shows [2…6]. */}
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
                onClick={() => applySize(n)}
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
            {(groupCopy.maxSizeHint ?? "Tối đa {n} người (theo số thợ rảnh)")
              .replace("{n}", String(maxGroupSize))}
          </p>

          <div className="mt-6 space-y-3">
            <h3 className="text-base font-medium">
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
              onChange={(e) => {
                setPrimaryPhone(formatPhoneInputProgressive(e.target.value));
                setContactPhoneError(false);
              }}
              className={cn(
                "nq-booking-field",
                contactPhoneError && "border-nq-error/50",
              )}
            />
            <input
              type="email"
              autoComplete="email"
              data-testid="group-primary-email"
              value={primaryEmail}
              placeholder={t.clientEmailLabel}
              onChange={(e) => setPrimaryEmail(e.target.value)}
              className="nq-booking-field"
            />
          </div>

          <div className="mt-6 flex justify-end">
            <LuxuryBookingCta
              onClick={() => {
                if (!sizeNextEnabled) {
                  setContactPhoneError(true);
                  return;
                }
                setStep("members");
              }}
            >
              {t.next}
            </LuxuryBookingCta>
          </div>
        </div>
      ) : null}

      {step === "members" ? (
        <div className="space-y-4 pb-32">
          {/* P0.G3 — renamed from "Xem lại lịch nhóm" (which read as
              "review your booking") to a data-entry-accurate heading. */}
          <h2 className="text-lg font-semibold sm:text-xl">
            {groupCopy.reviewHeading}
          </h2>

          {/* P1.G1 — sticky primary-contact summary. The user used
              to enter phone + email then lose them on step 2; now
              the values are visible + editable from a single
              "Sửa" link that pops back to step 1. */}
          <div
            className="rounded-xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] px-3 py-2.5 text-sm"
            data-testid="group-contact-summary"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1 truncate">
                <span className="text-[var(--booking-text-muted)]">
                  {groupCopy.primaryContactHeading}:
                </span>{" "}
                <span className="font-medium">
                  {primaryPhone}
                  {primaryEmail.trim().length > 0 ? ` · ${primaryEmail}` : ""}
                </span>
                <span className="text-[var(--booking-text-muted)]">
                  {" · "}
                  {size}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setStep("size")}
                className="shrink-0 text-xs font-semibold text-[var(--salon-primary)] underline-offset-2 hover:underline"
                data-testid="group-contact-edit"
              >
                {groupCopy.editContact ?? "Sửa"}
              </button>
            </div>
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

          {/* P0.G2 — shared schedule for the whole group. */}
          <div
            className="rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4 sm:p-5"
            data-testid="group-shared-schedule"
          >
            <h3 className="mb-2 text-base font-semibold">
              {groupCopy.sharedScheduleHeading ?? "Ngày & giờ chung của nhóm"}
            </h3>
            <p className="mb-3 text-xs text-[var(--booking-text-muted)]">
              {groupCopy.sharedScheduleHint ??
                "Cả nhóm đến cùng giờ. Mỗi người chọn dịch vụ và thợ riêng bên dưới."}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <input
                  ref={(el) => {
                    if (el && scheduleErrors.has("date") && !firstErrorRef.current)
                      firstErrorRef.current = el;
                  }}
                  type="date"
                  value={sharedDate}
                  onChange={(e) => {
                    setSharedDate(e.target.value);
                    setScheduleErrors((prev) => {
                      if (!prev.has("date")) return prev;
                      const next = new Set(prev);
                      next.delete("date");
                      return next;
                    });
                  }}
                  className={cn(
                    "nq-booking-field",
                    scheduleErrors.has("date") && "border-nq-error/50",
                  )}
                  data-testid="group-shared-date"
                />
              </div>
              <div>
                <input
                  ref={(el) => {
                    if (el && scheduleErrors.has("time") && !firstErrorRef.current)
                      firstErrorRef.current = el;
                  }}
                  type="time"
                  step={300}
                  value={sharedTime}
                  onChange={(e) => {
                    setSharedTime(e.target.value);
                    setScheduleErrors((prev) => {
                      if (!prev.has("time")) return prev;
                      const next = new Set(prev);
                      next.delete("time");
                      return next;
                    });
                  }}
                  className={cn(
                    "nq-booking-field tabular-nums",
                    scheduleErrors.has("time") && "border-nq-error/50",
                  )}
                  data-testid="group-shared-time"
                />
              </div>
            </div>
            {scheduleErrors.size > 0 ? (
              <p
                className="mt-2 text-xs font-semibold text-nq-error"
                role="alert"
                data-testid="group-shared-error"
              >
                {groupCopy.sharedScheduleRequired ??
                  "Vui lòng chọn ngày và giờ cho cả nhóm."}
              </p>
            ) : null}

            {/* QA STEP 4 — live availability pill. Three states:
                loading (subtle), available (green/muted), insufficient
                (red, blocks submit). Hidden when the data needed to
                compute it isn't ready yet (no time picked, no services
                selected yet). */}
            {availability.kind === "loading" ? (
              <p
                className="mt-2 text-xs text-[var(--booking-text-muted)]"
                data-testid="group-availability-loading"
              >
                {groupCopy.availabilityChecking ??
                  "Đang kiểm tra số thợ rảnh…"}
              </p>
            ) : null}
            {availability.kind === "ready" && !insufficientCapacity ? (
              <p
                className="mt-2 text-xs text-[var(--booking-text-muted)]"
                data-testid="group-availability-ok"
              >
                {(groupCopy.availabilityOk ??
                  "Có {free}/{total} thợ rảnh vào giờ này.")
                  .replace("{free}", String(availability.availableCount))
                  .replace("{total}", String(availability.totalActiveStaff))}
              </p>
            ) : null}
            {availability.kind === "ready" && insufficientCapacity ? (
              <p
                className="mt-2 rounded-lg border border-nq-error/40 bg-nq-error/10 px-3 py-2 text-xs font-semibold text-nq-error"
                role="alert"
                data-testid="group-availability-insufficient"
              >
                {(groupCopy.insufficientCapacity ??
                  "Chỉ còn {n} thợ rảnh vào thời điểm này. Vui lòng chọn giờ khác hoặc giảm số người.")
                  .replace("{n}", String(availability.availableCount))}
              </p>
            ) : null}
          </div>

          {/* Reset firstErrorRef before per-member cards iterate so
              the schedule error wins precedence if present. */}
          {(() => {
            if (scheduleErrors.size === 0) firstErrorRef.current = null;
            return null;
          })()}

          {members.map((m, i) => {
            const fields = memberErrors.get(i) ?? new Set<MemberFieldError>();
            const isDupStaff = duplicateStaffIdx.has(i);
            return (
              <MemberCard
                key={i}
                index={i}
                t={t}
                groupCopy={groupCopy}
                member={m}
                services={services}
                staff={staff}
                isConflict={conflictIdx.has(i)}
                isDuplicateStaff={isDupStaff}
                fieldErrors={fields}
                onChange={(patch) => patchMember(i, patch)}
                brandColor={salon.brandColor}
                registerErrorRef={(el) => {
                  if (el && fields.size > 0 && !firstErrorRef.current)
                    firstErrorRef.current = el;
                }}
              />
            );
          })}

          {/* P1.G8 — sticky total. Floats above the page so it stays
              visible while the user fills out tall member cards. */}
          <div
            className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--booking-border)] bg-[var(--booking-bg)] px-4 py-3 backdrop-blur"
            data-testid="group-sticky-footer"
          >
            <div className="mx-auto flex w-full max-w-[680px] flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div
                className="text-sm"
                data-testid="group-total-preview"
              >
                <span className="text-[var(--booking-text-muted)]">
                  {groupCopy.totalLabel ?? "Tổng"}:
                </span>{" "}
                <span className="font-semibold">
                  {size} {groupCopy.peopleSuffix ?? "người"} ·{" "}
                  {totals.maxMinutes} {t.minuteSuffixShort}
                  {totalDisplay ? ` · ${totalDisplay}` : ""}
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setStep("size")}
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
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function MemberCard({
  index,
  t,
  groupCopy,
  member,
  services,
  staff,
  isConflict,
  isDuplicateStaff,
  fieldErrors,
  onChange,
  brandColor,
  registerErrorRef,
}: {
  index: number;
  t: BookingMessages;
  groupCopy: NonNullable<BookingMessages["groupBooking"]>;
  member: MemberDraft;
  services: readonly BookingServiceItem[];
  staff: readonly BookingStaffItem[];
  isConflict: boolean;
  isDuplicateStaff: boolean;
  fieldErrors: Set<MemberFieldError>;
  onChange: (patch: Partial<MemberDraft>) => void;
  brandColor: string;
  /** Ref-callback so the parent can scroll to the first error on
   * submit-click. */
  registerErrorRef: (el: HTMLElement | null) => void;
}) {
  const ready =
    member.name.trim().length > 0 && member.serviceId && member.staffId;
  return (
    <div
      data-testid={`group-member-${index}`}
      data-conflict={isConflict || undefined}
      className={cn(
        "rounded-2xl border bg-[var(--booking-bg-card)] p-4 sm:p-5",
        isConflict || isDuplicateStaff
          ? "border-nq-error/60 ring-1 ring-nq-error/40"
          : "border-[var(--booking-border)]",
      )}
    >
      <h3 className="mb-3 text-base font-semibold">
        {groupCopy.personLabel.replace("{n}", String(index + 1))}
      </h3>
      {isConflict ? (
        <p
          className="mb-3 text-xs font-semibold text-nq-error"
          data-testid={`group-member-${index}-conflict`}
        >
          {groupCopy.conflictMember.replace("{n}", String(index + 1))}
        </p>
      ) : null}

      <div className="space-y-3">
        <div>
          <input
            ref={(el) => {
              if (fieldErrors.has("name")) registerErrorRef(el);
            }}
            type="text"
            autoComplete="name"
            placeholder={t.clientNameLabel}
            value={member.name}
            maxLength={100}
            onChange={(e) => onChange({ name: e.target.value })}
            className={cn(
              "nq-booking-field",
              // Filled value is high-contrast; empty falls back to
              // the muted placeholder color. Fixes the P2 "input
              // value looks like placeholder" report.
              member.name.trim().length > 0 &&
                "font-medium text-[var(--booking-text)]",
              fieldErrors.has("name") && "border-nq-error/50",
            )}
            data-testid={`group-member-${index}-name`}
          />
          {fieldErrors.has("name") ? (
            <p className="mt-1 text-xs text-nq-error">
              {t.bookingErrors.nameRequired}
            </p>
          ) : null}
        </div>

        <div>
          <select
            ref={(el) => {
              if (fieldErrors.has("service")) registerErrorRef(el);
            }}
            value={member.serviceId}
            onChange={(e) => onChange({ serviceId: e.target.value })}
            className={cn(
              "nq-booking-field",
              fieldErrors.has("service") && "border-nq-error/50",
            )}
            data-testid={`group-member-${index}-service`}
            style={{
              color: member.serviceId ? "var(--booking-text)" : "var(--booking-text-muted)",
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
          {fieldErrors.has("service") ? (
            <p className="mt-1 text-xs text-nq-error">
              {t.bookingErrors.serviceRequired}
            </p>
          ) : null}
        </div>

        <div>
          <select
            ref={(el) => {
              if (fieldErrors.has("staff")) registerErrorRef(el);
            }}
            value={member.staffId}
            onChange={(e) => onChange({ staffId: e.target.value })}
            className={cn(
              "nq-booking-field",
              (fieldErrors.has("staff") || isDuplicateStaff) &&
                "border-nq-error/50",
            )}
            data-testid={`group-member-${index}-staff`}
            style={{
              color: member.staffId ? "var(--booking-text)" : "var(--booking-text-muted)",
            }}
          >
            <option value="">— {t.breadcrumbStaff} —</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {fieldErrors.has("staff") ? (
            <p className="mt-1 text-xs text-nq-error">
              {groupCopy.staffRequired ?? "Chọn thợ."}
            </p>
          ) : isDuplicateStaff ? (
            <p
              className="mt-1 text-xs font-semibold text-nq-error"
              data-testid={`group-member-${index}-duplicate-staff`}
            >
              {(groupCopy.duplicateStaff ??
                "This staff is already chosen for another person — pick a different staff.")
                .replace("{n}", String(index))}
            </p>
          ) : null}
        </div>
      </div>
      {ready && !isConflict && !isDuplicateStaff ? (
        <div
          aria-hidden
          className="mt-3 h-0.5 w-12 rounded-full"
          style={{ background: brandColor }}
        />
      ) : null}
    </div>
  );
}
