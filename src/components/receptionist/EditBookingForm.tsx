"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { editBookingAction } from "@/shared/dashboard/editBookingAction";
import type { ReceptionistMessages } from "@/shared/i18n/user";
import {
  buildCapabilityMap,
  filterStaffCapableForService,
} from "@/shared/booking/staffCapability";
import {
  formatInSalonTz,
  salonWallTimeToUtcIso,
  utcIsoToSalonMinutesFromMidnight,
} from "@/shared/lib/salonTime";
import type { SalonDashboardBooking } from "@/shared/types";
import { cn } from "@/shared/lib/cn";

/** Desk day row: ids + times required for edit defaults (receptionist `bookingsForDay`).
 *  Addon fields ride along for read-only display + correct end-time calc on save. */
export type EditBookingFormBooking = SalonDashboardBooking & {
  staff_id: string;
  service_id: string;
  start_time_utc: string;
  end_time_utc: string;
  addon_service_id: string | null;
  addon_service_name: string | null;
  addon_duration_minutes: number | null;
  addon_buffer_minutes: number | null;
  addon_price_cents: number | null;
};

const SLOT_START_MIN = 8 * 60;
const SLOT_END_MIN = 19 * 60 + 30;

function slotMinutesOptions(): number[] {
  const out: number[] = [];
  for (let m = SLOT_START_MIN; m <= SLOT_END_MIN; m += 30) {
    out.push(m);
  }
  return out;
}

function slotLabel(dayYmd: string, minutesFromMidnight: number, timezone: string): string {
  const utc = salonWallTimeToUtcIso(dayYmd, minutesFromMidnight, timezone);
  return formatInSalonTz(utc, timezone, "time");
}

function nearestSlotMinutes(bookingMinutes: number, slots: number[]): number {
  let best = slots[0] ?? SLOT_START_MIN;
  let bestDist = Math.abs(best - bookingMinutes);
  for (const s of slots) {
    const d = Math.abs(s - bookingMinutes);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

function initialSlotForBooking(bookingMinutes: number, slots: number[]): number {
  return slots.includes(bookingMinutes)
    ? bookingMinutes
    : nearestSlotMinutes(bookingMinutes, slots);
}

function sameUtcInstant(a: string, b: string): boolean {
  return Date.parse(a) === Date.parse(b);
}

export interface EditBookingFormProps {
  slug: string;
  booking: EditBookingFormBooking;
  bookingId: string;
  salonId: string;
  staff: { id: string; name: string }[];
  services: {
    id: string;
    name: string;
    price_cents: number;
    duration_minutes: number;
    buffer_minutes: number;
  }[];
  /** Per-staff service whitelist for the salon. `null` = no rows → all-capable fallback. */
  capabilityRows: { staff_id: string; service_id: string }[] | null;
  dayYmd: string;
  timezone: string;
  /**
   * Realtime offline guard — when true, Save is disabled and an
   * inline offline hint replaces the regular save-disabled tooltip.
   * Inputs remain interactive so the receptionist's draft state isn't
   * lost; only the mutation submit is gated.
   */
  isOffline?: boolean;
  /** Localized "Offline — editing unavailable" hint. */
  offlineEditDisabledHint?: string;
  onSaved: (updated: SalonDashboardBooking) => void;
  onCancel: () => void;
  rcMessages: ReceptionistMessages;
}

export function EditBookingForm({
  slug,
  booking,
  bookingId,
  salonId,
  staff,
  services,
  capabilityRows,
  dayYmd,
  timezone,
  isOffline = false,
  offlineEditDisabledHint,
  onSaved,
  onCancel,
  rcMessages,
}: EditBookingFormProps) {
  const slots = useMemo(() => slotMinutesOptions(), []);

  const originalStaff = booking.staff_id;
  const originalService = booking.service_id;
  const originalTimeMinutes = useMemo(() => {
    return utcIsoToSalonMinutesFromMidnight(booking.start_time_utc, timezone);
  }, [booking.start_time_utc, timezone]);

  const [selectedTimeMinutes, setSelectedTimeMinutes] = useState(() =>
    initialSlotForBooking(originalTimeMinutes, slots),
  );
  const [selectedStaff, setSelectedStaff] = useState(originalStaff);
  const [selectedService, setSelectedService] = useState(originalService);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSvc = useMemo(
    () => services.find((s) => s.id === selectedService),
    [services, selectedService],
  );

  const capability = useMemo(
    () => buildCapabilityMap(capabilityRows),
    [capabilityRows],
  );

  /** Staff who can perform the currently-selected service.
   *  Always includes the original staff so we never disappear an existing
   *  assignment from the dropdown — the server backstop will reject the
   *  save if the owner truly hasn't granted that capability. */
  const capableStaff = useMemo(() => {
    const filtered = filterStaffCapableForService(staff, capability, selectedService);
    if (
      originalStaff &&
      filtered.every((s) => s.id !== originalStaff) &&
      staff.some((s) => s.id === originalStaff)
    ) {
      const original = staff.find((s) => s.id === originalStaff);
      return original ? [original, ...filtered] : filtered;
    }
    return filtered;
  }, [staff, capability, selectedService, originalStaff]);

  /** Snap the selection to a capable staff when the service change makes the
   *  current pick incapable. Prefer the original assignee, otherwise the
   *  first capable option. */
  useEffect(() => {
    if (capableStaff.some((s) => s.id === selectedStaff)) return;
    const fallback =
      (capableStaff.find((s) => s.id === originalStaff)?.id) ??
      capableStaff[0]?.id ??
      "";
    if (fallback && fallback !== selectedStaff) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- guard: snap selection back to a capable staff when the service change invalidates the current pick
      setSelectedStaff(fallback);
    }
  }, [capableStaff, selectedStaff, originalStaff]);

  /** Addon, when present, contributes to span + price but is read-only in v1. */
  const addonSpanMinutes = useMemo(() => {
    if (!booking.addon_service_id) return 0;
    const dur = Math.max(0, Math.round(Number(booking.addon_duration_minutes ?? 0)));
    const buf = Math.max(0, Math.round(Number(booking.addon_buffer_minutes ?? 0)));
    return dur + buf;
  }, [
    booking.addon_service_id,
    booking.addon_duration_minutes,
    booking.addon_buffer_minutes,
  ]);

  const endTimeDisplay = useMemo(() => {
    if (!selectedSvc) return "—";
    const startUtc = salonWallTimeToUtcIso(dayYmd, selectedTimeMinutes, timezone);
    const mainTotal =
      Number(selectedSvc.duration_minutes) + Number(selectedSvc.buffer_minutes);
    if (!Number.isFinite(mainTotal) || mainTotal < 1) return "—";
    const total = mainTotal + addonSpanMinutes;
    const endMs = Date.parse(startUtc) + total * 60 * 1000;
    if (Number.isNaN(endMs)) return "—";
    return formatInSalonTz(new Date(endMs).toISOString(), timezone, "time");
  }, [dayYmd, selectedSvc, selectedTimeMinutes, timezone, addonSpanMinutes]);

  const priceDisplay = useMemo(() => {
    if (!selectedSvc) return "—";
    const mainCents = Number(selectedSvc.price_cents);
    if (!Number.isFinite(mainCents)) return "—";
    const addonCents = booking.addon_service_id
      ? Number(booking.addon_price_cents ?? 0)
      : 0;
    const total = mainCents + (Number.isFinite(addonCents) ? addonCents : 0);
    return `$${(total / 100).toFixed(2)}`;
  }, [selectedSvc, booking.addon_service_id, booking.addon_price_cents]);

  const addonReadonly = useMemo(() => {
    if (!booking.addon_service_id) return null;
    const name = booking.addon_service_name?.trim() || "—";
    const dur = Math.max(0, Math.round(Number(booking.addon_duration_minutes ?? 0)));
    const cents = Number(booking.addon_price_cents ?? 0);
    const priceLabel = Number.isFinite(cents)
      ? `$${(cents / 100).toFixed(2)}`
      : "—";
    return { name, dur, priceLabel };
  }, [
    booking.addon_service_id,
    booking.addon_service_name,
    booking.addon_duration_minutes,
    booking.addon_price_cents,
  ]);

  const proposedStartUtc = useMemo(
    () => salonWallTimeToUtcIso(dayYmd, selectedTimeMinutes, timezone),
    [dayYmd, selectedTimeMinutes, timezone],
  );

  const hasChanges =
    !sameUtcInstant(proposedStartUtc, booking.start_time_utc) ||
    selectedStaff !== originalStaff ||
    selectedService !== originalService;

  const editCopy = rcMessages.edit;

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    const newStartTimeUtc = salonWallTimeToUtcIso(
      dayYmd,
      selectedTimeMinutes,
      timezone,
    );

    const result = await editBookingAction(slug, {
      salonId,
      bookingId,
      newStartTimeUtc,
      newStaffId: selectedStaff,
      newServiceId: selectedService,
    });

    setSaving(false);

    if (result.ok) {
      onSaved(result.updated);
      return;
    }

    if (result.error === "slot_conflict") {
      setError(
        rcMessages.edit.conflictMessage.replace(
          "{name}",
          result.conflictWith ?? "",
        ),
      );
      return;
    }

    switch (result.error) {
      case "not_found":
        setError(editCopy.not_foundMessage);
        break;
      case "invalid_status":
        setError(editCopy.invalid_statusMessage);
        break;
      case "server_error":
        setError(editCopy.serverErrorMessage);
        break;
      default:
        setError(editCopy.serverErrorMessage);
    }
  };

  return (
    <div className="space-y-3 bg-nq-surface pb-2 pt-1" data-testid="edit-booking-form">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
        {editCopy.modeTitle}
      </p>
      <div className="grid gap-3 sm:grid-cols-1">
        <label className="block space-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
            {editCopy.timeLabel}
          </span>
          <select
            data-testid="edit-time-select"
            className={cn(
              "min-h-11 w-full rounded-lg border border-nq-muted/40 bg-nq-bg px-3 text-sm text-nq-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40",
            )}
            value={String(selectedTimeMinutes)}
            onChange={(e) => setSelectedTimeMinutes(Number(e.target.value))}
          >
            {slots.map((m) => (
              <option key={m} value={String(m)}>
                {slotLabel(dayYmd, m, timezone)}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
            {editCopy.staffLabel}
          </span>
          <select
            data-testid="edit-staff-select"
            className={cn(
              "min-h-11 w-full rounded-lg border border-nq-muted/40 bg-nq-bg px-3 text-sm text-nq-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40",
            )}
            value={selectedStaff}
            onChange={(e) => setSelectedStaff(e.target.value)}
          >
            {capableStaff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
            {editCopy.serviceLabel}
          </span>
          <select
            data-testid="edit-service-select"
            className={cn(
              "min-h-11 w-full rounded-lg border border-nq-muted/40 bg-nq-bg px-3 text-sm text-nq-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40",
            )}
            value={selectedService}
            onChange={(e) => setSelectedService(e.target.value)}
          >
            {services.map((s) => {
              const dollars = (Number(s.price_cents) / 100).toFixed(2);
              const dur = Number(s.duration_minutes);
              return (
                <option key={s.id} value={s.id}>
                  {`${s.name} · ${dur}m · $${dollars}`}
                </option>
              );
            })}
          </select>
        </label>

        {addonReadonly ? (
          <div
            className="block space-y-1"
            data-testid="edit-addon-readonly"
          >
            <span className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
              {rcMessages.drawer.sectionAddon}
            </span>
            <p className="rounded-lg border border-nq-muted/30 bg-nq-bg px-3 py-2 text-sm text-nq-foreground">
              {`${addonReadonly.name} · ${addonReadonly.dur}m · ${addonReadonly.priceLabel}`}
            </p>
          </div>
        ) : null}
      </div>

      <div className="space-y-1 text-sm text-nq-muted">
        <p>
          <span className="font-semibold text-nq-foreground/90">
            {editCopy.endTimePrefix}
          </span>{" "}
          <span className="text-nq-foreground">{endTimeDisplay}</span>
        </p>
        <p>
          <span className="font-semibold text-nq-foreground/90">
            {editCopy.pricePrefix}
          </span>{" "}
          <span className="text-nq-foreground">{priceDisplay}</span>
        </p>
      </div>

      {error ? (
        <p
          className="text-xs font-medium text-nq-error"
          role="alert"
          data-testid="edit-error-message"
        >
          {error}
        </p>
      ) : null}

      {isOffline && offlineEditDisabledHint ? (
        <p
          className="text-xs font-semibold text-nq-error"
          role="status"
          data-testid="edit-offline-hint"
        >
          {offlineEditDisabledHint}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          data-testid="edit-cancel-button"
          className="w-full sm:w-auto"
          onClick={onCancel}
        >
          {editCopy.cancelButton}
        </Button>
        <Button
          type="button"
          variant="primary"
          data-testid="edit-save-button"
          className="w-full sm:w-auto"
          loading={saving}
          disabled={!hasChanges || saving || isOffline}
          title={
            isOffline
              ? offlineEditDisabledHint
              : !hasChanges && !saving
                ? editCopy.noChangesHint
                : undefined
          }
          onClick={() => void handleSave()}
        >
          {saving ? editCopy.saving : editCopy.saveButton}
        </Button>
      </div>
    </div>
  );
}
