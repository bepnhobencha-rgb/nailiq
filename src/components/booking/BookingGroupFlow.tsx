"use client";

import { useMemo, useState } from "react";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type {
  BookingSalonMeta,
  BookingStaffItem,
} from "@/shared/booking/loadBookingServices";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import {
  submitGroupBooking,
  type GroupBookingMember,
  type GroupBookingResult,
} from "@/shared/booking/submitGroupBooking";
import { formatPhoneInputProgressive } from "@/shared/lib/phoneFormat";
import { cn } from "@/shared/lib/cn";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import { Button } from "@/components/ui/Button";

type BookingGroupFlowProps = {
  t: BookingMessages;
  shopSlug: string;
  services: readonly BookingServiceItem[];
  staff: readonly BookingStaffItem[];
  salon: BookingSalonMeta;
};

type MemberDraft = {
  name: string;
  phone: string;
  email: string;
  notes: string;
  serviceId: string;
  staffId: string;
  date: string;
  time: string;
};

function blankMember(
  primaryPhone: string,
  primaryEmail: string,
  defaults: Partial<Pick<MemberDraft, "date" | "time">> = {},
): MemberDraft {
  return {
    name: "",
    phone: primaryPhone,
    email: primaryEmail,
    notes: "",
    serviceId: "",
    staffId: "",
    date: defaults.date ?? "",
    time: defaults.time ?? "",
  };
}

function memberReady(m: MemberDraft): boolean {
  return (
    m.name.trim().length > 0 &&
    m.phone.trim().length > 0 &&
    m.serviceId.length > 0 &&
    m.staffId.length > 0 &&
    m.date.length > 0 &&
    m.time.length > 0
  );
}

type Step = "size" | "members" | "review" | "success";

export function BookingGroupFlow({
  t,
  shopSlug,
  services,
  staff,
  salon,
}: BookingGroupFlowProps) {
  const [step, setStep] = useState<Step>("size");
  const [size, setSize] = useState<2 | 3 | 4>(2);
  const [primaryPhone, setPrimaryPhone] = useState("");
  const [primaryEmail, setPrimaryEmail] = useState("");
  const [members, setMembers] = useState<MemberDraft[]>(() => [
    blankMember("", ""),
    blankMember("", ""),
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [conflictIdx, setConflictIdx] = useState<Set<number>>(() => new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<{
    groupId: string;
    bookingIds: string[];
  } | null>(null);

  const groupCopy = t.groupBooking;

  const allReady = useMemo(
    () => members.length === size && members.every(memberReady),
    [members, size],
  );

  const sizeNextEnabled = primaryPhone.trim().length > 0;

  function applySize(n: 2 | 3 | 4) {
    setSize(n);
    setMembers((prev) => {
      const next: MemberDraft[] = [];
      for (let i = 0; i < n; i++) {
        next.push(prev[i] ?? blankMember(primaryPhone, primaryEmail));
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
    // Clear the per-member conflict highlight once the user touches
    // anything on that card.
    setConflictIdx((prev) => {
      if (!prev.has(i)) return prev;
      const next = new Set(prev);
      next.delete(i);
      return next;
    });
    setErrorMessage(null);
  }

  async function onSubmit() {
    setSubmitting(true);
    setErrorMessage(null);
    setConflictIdx(new Set());
    try {
      const payload: GroupBookingMember[] = members.map((m) => ({
        name: m.name,
        // Fall back to the primary contact phone when the member
        // didn't enter their own — every booking row needs a phone.
        phone: m.phone.trim().length > 0 ? m.phone : primaryPhone,
        email:
          (m.email.trim().length > 0 ? m.email : primaryEmail).trim() ||
          undefined,
        notes: m.notes.trim() || undefined,
        serviceId: m.serviceId,
        staffId: m.staffId,
        date: m.date,
        time: m.time,
      }));
      const res: GroupBookingResult = await submitGroupBooking({
        shopSlug,
        members: payload,
        // Each submit attempt gets a fresh idempotency key. A
        // network retry of the SAME request reuses the same fetch
        // call — we don't need to dedupe at this level. The DB
        // UNIQUE is a backstop for accidental client re-submission
        // (e.g. double click before this state flips submitting).
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
        setStep("members");
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
                  {svc?.name} · {st?.name} · {m.date} {m.time}
                </span>
              </li>
            );
          })}
        </ul>
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
          <div className="flex gap-2" role="radiogroup" aria-label={groupCopy.sizeHeading}>
            {([2, 3, 4] as const).map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={size === n}
                data-testid={`group-size-${n}`}
                onClick={() => applySize(n)}
                className={cn(
                  "min-h-11 flex-1 rounded-xl border text-lg font-semibold transition-colors",
                  size === n
                    ? "border-[var(--salon-primary)] bg-[var(--salon-primary)] text-[var(--booking-bg)]"
                    : "border-[var(--booking-border)] bg-[var(--booking-bg-input)]",
                )}
              >
                {n}
              </button>
            ))}
          </div>

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
              onChange={(e) => setPrimaryPhone(formatPhoneInputProgressive(e.target.value))}
              className="nq-booking-field"
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
              onClick={() => setStep("members")}
              disabled={!sizeNextEnabled}
            >
              {t.next}
            </LuxuryBookingCta>
          </div>
        </div>
      ) : null}

      {step === "members" ? (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold sm:text-xl">
            {groupCopy.reviewHeading}
          </h2>

          {errorMessage ? (
            <p
              role="alert"
              data-testid="group-error"
              className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
            >
              {errorMessage}
            </p>
          ) : null}

          {members.map((m, i) => (
            <MemberCard
              key={i}
              index={i}
              t={t}
              member={m}
              services={services}
              staff={staff}
              isConflict={conflictIdx.has(i)}
              onChange={(patch) => patchMember(i, patch)}
              brandColor={salon.brandColor}
            />
          ))}

          <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setStep("size")}
              className="nq-booking-glass h-14 min-h-11 w-full shrink-0 border border-[var(--booking-border)] bg-transparent text-[var(--booking-text-muted)] shadow-none sm:w-auto sm:min-w-[8.5rem]"
            >
              {t.back}
            </Button>
            <LuxuryBookingCta
              onClick={onSubmit}
              disabled={!allReady || submitting}
              data-testid="group-confirm"
            >
              {submitting ? groupCopy.submittingGroup : groupCopy.confirmGroup}
            </LuxuryBookingCta>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function MemberCard({
  index,
  t,
  member,
  services,
  staff,
  isConflict,
  onChange,
  brandColor,
}: {
  index: number;
  t: BookingMessages;
  member: MemberDraft;
  services: readonly BookingServiceItem[];
  staff: readonly BookingStaffItem[];
  isConflict: boolean;
  onChange: (patch: Partial<MemberDraft>) => void;
  brandColor: string;
}) {
  const groupCopy = t.groupBooking;
  return (
    <div
      data-testid={`group-member-${index}`}
      data-conflict={isConflict || undefined}
      className={cn(
        "rounded-2xl border bg-[var(--booking-bg-card)] p-4 sm:p-5",
        isConflict
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
        <input
          type="text"
          autoComplete="name"
          placeholder={t.clientNameLabel}
          value={member.name}
          maxLength={100}
          onChange={(e) => onChange({ name: e.target.value })}
          className="nq-booking-field"
          data-testid={`group-member-${index}-name`}
        />

        <select
          value={member.serviceId}
          onChange={(e) => onChange({ serviceId: e.target.value })}
          className="nq-booking-field"
          data-testid={`group-member-${index}-service`}
          style={{ color: member.serviceId ? "var(--booking-text)" : "var(--booking-text-muted)" }}
        >
          <option value="">— {t.breadcrumbServices} —</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.totalMinutes} {t.minuteSuffixShort}
              {s.priceDisplay ? ` · ${s.priceDisplay}` : ""}
            </option>
          ))}
        </select>

        <select
          value={member.staffId}
          onChange={(e) => onChange({ staffId: e.target.value })}
          className="nq-booking-field"
          data-testid={`group-member-${index}-staff`}
          style={{ color: member.staffId ? "var(--booking-text)" : "var(--booking-text-muted)" }}
        >
          <option value="">— {t.breadcrumbStaff} —</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <div className="grid grid-cols-2 gap-2">
          <input
            type="date"
            value={member.date}
            onChange={(e) => onChange({ date: e.target.value })}
            className="nq-booking-field"
            data-testid={`group-member-${index}-date`}
          />
          <input
            type="time"
            step={300}
            value={member.time}
            onChange={(e) => onChange({ time: e.target.value })}
            className="nq-booking-field tabular-nums"
            data-testid={`group-member-${index}-time`}
          />
        </div>
      </div>
      {/* Use the salon brand color as a thin accent under the
          heading once the member's slot is fully filled. Cheap
          visual nudge that "this person is ready". */}
      {memberReady(member) && !isConflict ? (
        <div
          aria-hidden
          className="mt-3 h-0.5 w-12 rounded-full"
          style={{ background: brandColor }}
        />
      ) : null}
    </div>
  );
}
