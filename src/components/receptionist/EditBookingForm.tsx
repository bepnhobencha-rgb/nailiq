"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { editBookingAction } from "@/shared/dashboard/editBookingAction";
import {
  getDeskBookingData,
  getResourceAvailability,
} from "@/shared/dashboard/receptionistActions";
import { computeBookingTiming } from "@/shared/booking/bookingTiming";
import { addonLabel } from "@/shared/booking/serviceLabels";
import {
  getAvailableTimeSlots,
  type TimeSlot,
} from "@/shared/booking/getAvailableTimeSlots";
import type { ReceptionistMessages } from "@/shared/i18n/user";
import {
  buildCapabilityMap,
  filterStaffCapableForService,
  type StaffCapabilityMode,
} from "@/shared/booking/staffCapability";
import {
  formatInSalonTz,
  salonToday,
  salonWallTimeToUtcIso,
  utcIsoToSalonMinutesFromMidnight,
} from "@/shared/lib/salonTime";
import { ymdToLocalNoon } from "@/shared/lib/localDateYmd";
import type { SalonDashboardBooking } from "@/shared/types";
import { cn } from "@/shared/lib/cn";
import { formatCurrency, formatServicePrice } from "@/shared/lib/currencyFormat";

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
  /** Currently-assigned resource (bed/chair) id. Null when no resource or resources_enabled=false. */
  resource_id?: string | null;
};

type DeskData = Extract<
  Awaited<ReturnType<typeof getDeskBookingData>>,
  { ok: true }
>["data"];

/** Salon-local minutes-from-midnight → "h:mm AM/PM". MUST stay byte-identical to
 *  the `minutesToLabel` helper inside getAvailableTimeSlots so we can match the
 *  booking's original slot against grid labels by string (Intl can emit a narrow
 *  no-break space, which would break that match). */
function minutesToSlotLabel(mins: number): string {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h24 >= 12 ? "PM" : "AM";
  let h = h24 % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${period}`;
}

/** Parse a grid slot label ("9:00 AM") back to minutes-from-midnight. Inverse of
 *  `minutesToSlotLabel`; used to build the UTC start instant on save. */
function slotLabelToMinutes(label: string): number | null {
  const m = label.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  const min = Number(m[2]);
  if (m[3].toUpperCase() === "PM") h += 12;
  const total = h * 60 + min;
  if (!Number.isFinite(total) || total < 0 || total >= 24 * 60) return null;
  return total;
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
    price_type: string;
    price_max_cents: number | null;
    duration_minutes: number;
    buffer_minutes: number;
  }[];
  /** Per-staff service rows; interpret empty/null using staffCapabilityMode. */
  capabilityRows: { staff_id: string; service_id: string }[] | null;
  staffCapabilityMode: StaffCapabilityMode;
  /** Booking's original salon-local day (YYYY-MM-DD). Kept for back-compat; the
   *  form now derives the initial day from the booking start so the day picker
   *  can move off it. */
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
  /** P0.2 — salon's configured currency. Drives the service dropdown
   * price suffix + the total price preview. */
  currency: import("@/shared/lib/currencyFormat").Currency;
}

export function EditBookingForm({
  slug,
  booking,
  bookingId,
  salonId,
  staff,
  services,
  capabilityRows,
  staffCapabilityMode,
  // `dayYmd` stays in the props interface for caller back-compat but is no longer
  // read here — the initial day is derived from the booking's start instant
  // (salon-tz), the canonical source, so the day picker can move off it.
  timezone,
  isOffline = false,
  offlineEditDisabledHint,
  onSaved,
  onCancel,
  rcMessages,
  currency,
}: EditBookingFormProps) {
  const originalStaff = booking.staff_id;
  const originalService = booking.service_id;

  // Booking's original salon-local day + slot label — the day picker initializes
  // here and the self-occupancy fix keys off them.
  const originalDayYmd = useMemo(
    () => salonToday(timezone, booking.start_time_utc),
    [timezone, booking.start_time_utc],
  );
  const originalTimeMinutes = useMemo(
    () => utcIsoToSalonMinutesFromMidnight(booking.start_time_utc, timezone),
    [booking.start_time_utc, timezone],
  );
  const originalSlotLabel = useMemo(
    () => minutesToSlotLabel(originalTimeMinutes),
    [originalTimeMinutes],
  );

  // Today in salon tz — `min` for the date input so the desk can't reschedule
  // into the past.
  const minDayYmd = useMemo(() => salonToday(timezone), [timezone]);

  const [selectedDay, setSelectedDay] = useState(originalDayYmd);
  const [selectedSlotLabel, setSelectedSlotLabel] = useState(originalSlotLabel);
  const [selectedStaff, setSelectedStaff] = useState(originalStaff);
  const [selectedService, setSelectedService] = useState(originalService);
  // `selectedAddon === ""` represents "no add-on" (matches the empty
  // <option> below). Initial value mirrors whatever the booking already
  // carries so an unchanged form doesn't accidentally remove the addon.
  const originalAddon = booking.addon_service_id ?? "";
  const [selectedAddon, setSelectedAddon] = useState<string>(originalAddon);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bed/resource picker state (resource-mode salons only).
  const originalResourceId = booking.resource_id ?? null;
  const [resourceId, setResourceId] = useState<string | null>(originalResourceId);
  // Raw fetch result, tagged with the time window it was fetched for. What the
  // picker renders — and whether it is still loading — is derived from that
  // below, so the effect never has to set either synchronously.
  const [fetchedResources, setFetchedResources] = useState<{
    key: string;
    resources: { id: string; name: string; displayOrder: number; isAvailable: boolean }[];
  }>({ key: "", resources: [] });

  // Salon meta (opening hours / closures / lead time) + add-ons — fetched once,
  // exactly like DeskBookingForm, so the grid shows REAL open times.
  const [deskData, setDeskData] = useState<DeskData | null>(null);
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getDeskBookingData(slug).then((res) => {
      if (cancelled) return;
      if (res.ok) setDeskData(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const selectedSvc = useMemo(
    () => services.find((s) => s.id === selectedService),
    [services, selectedService],
  );

  const capability = useMemo(
    () => buildCapabilityMap(capabilityRows, staffCapabilityMode),
    [capabilityRows, staffCapabilityMode],
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

  /** Resolved add-on row for the current select value; null when "None".
   *  Add-ons come from getDeskBookingData (already filtered by `is_addon`). */
  const selectedAddonSvc = useMemo(() => {
    if (!selectedAddon || !deskData) return null;
    return deskData.addOns.find((s) => s.id === selectedAddon) ?? null;
  }, [selectedAddon, deskData]);

  const bookingTiming = useMemo(() => {
    if (!selectedSvc) {
      return {
        blockMinutes: 0,
        serviceCompletionMinutes: 0,
        trailingBufferMinutes: 0,
      };
    }
    return computeBookingTiming(
      {
        durationMinutes: selectedSvc.duration_minutes,
        bufferMinutes: selectedSvc.buffer_minutes,
      },
      selectedAddonSvc
        ? [
            {
              durationMinutes: selectedAddonSvc.durationMinutes,
              bufferMinutes: selectedAddonSvc.bufferMinutes,
              concurrent: selectedAddonSvc.addonConcurrent,
            },
          ]
        : [],
    );
  }, [selectedSvc, selectedAddonSvc]);

  /** Full occupied span, including the final cleanup buffer. */
  const totalSpanMinutes = bookingTiming.blockMinutes;

  const closedDateYmdSet = useMemo(() => {
    const raw = deskData?.salon.booking_closed_dates;
    return new Set(Array.isArray(raw) ? (raw as string[]) : []);
  }, [deskData]);

  const shortestServiceMinutes = useMemo(
    () => (deskData ? Math.min(...deskData.services.map((s) => s.totalMinutes)) : 0),
    [deskData],
  );

  // The exact window the beds are being checked for, or null when the picker
  // does not apply yet (not a resource salon, no slot, no service).
  // Placed after totalSpanMinutes + selectedSvc to avoid temporal dead zone.
  const resourceWindow = useMemo(() => {
    if (!deskData?.salon.resourcesEnabled || !selectedSlotLabel || !selectedSvc) return null;
    const startMin = slotLabelToMinutes(selectedSlotLabel);
    if (startMin == null) return null;
    const startUtc = salonWallTimeToUtcIso(selectedDay, startMin, timezone);
    const endMs = Date.parse(startUtc) + totalSpanMinutes * 60 * 1000;
    if (Number.isNaN(endMs)) return null;
    return { startUtc, endUtc: new Date(endMs).toISOString() };
  }, [deskData, selectedSlotLabel, selectedSvc, selectedDay, totalSpanMinutes, timezone]);

  // Both of these are facts about `resourceWindow` vs what has been fetched,
  // so they are derived rather than set from the effect below.
  // Every argument the request is made with, so a different salon or booking on
  // the same time window counts as a different request. JSON.stringify rather
  // than a delimiter so no value can forge a boundary.
  const resourceKey = resourceWindow
    ? JSON.stringify([slug, bookingId, resourceWindow.startUtc, resourceWindow.endUtc])
    : "";
  const resourceOptions = resourceKey && fetchedResources.key === resourceKey
    ? fetchedResources.resources
    : [];
  const resourceLoading = resourceKey !== "" && fetchedResources.key !== resourceKey;

  // Fetch bed availability whenever the selected slot changes (resource-mode only).
  useEffect(() => {
    if (!resourceWindow) return;
    const requestKey = resourceKey;
    let cancelled = false;
    void getResourceAvailability(slug, resourceWindow.startUtc, resourceWindow.endUtc, bookingId)
      .then((res) => {
        if (cancelled) return;
        setFetchedResources({ key: requestKey, resources: res.ok ? res.resources : [] });
      })
      .catch(() => {
        // The action itself rejected — settle the key anyway so the picker
        // stops saying "Checking…" forever.
        if (!cancelled) setFetchedResources({ key: requestKey, resources: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [resourceWindow, resourceKey, slug, bookingId]);

  // getAvailableTimeSlots wants `BookingStaffItem` (incl. job_role). The edit
  // form's `staff` prop is {id,name} only, so recover job_role from deskData
  // when present (job_role is only consulted on the ANY-staff path, which edit
  // never uses — a concrete staff is always selected — so the fallback is safe).
  const slotStaffList = useMemo(
    () =>
      capableStaff.map((s) => ({
        id: s.id,
        name: s.name,
        job_role: deskData?.staff.find((d) => d.id === s.id)?.job_role ?? "",
      })),
    [capableStaff, deskData],
  );

  // Compute the availability grid whenever the inputs that affect it change.
  // EDGE — self-occupancy: getAvailableTimeSlots fetches ALL occupancy, which
  // INCLUDES this very booking, so on the booking's original day its current
  // slot comes back `available: false`. We patch it back to available because
  // the only thing blocking it is the booking we're editing, and the server
  // (`performEditBooking`) passes `excludeBookingId`, so saving onto the
  // original time is safe. We also inject the original slot if it isn't on the
  // grid at all (e.g. an off-grid start time).
  useEffect(() => {
    if (!deskData || !selectedSvc || !selectedStaff || !selectedDay || totalSpanMinutes < 1) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale grid when inputs incomplete
      setSlots([]);
      return;
    }
    if (selectedDay < minDayYmd) {
      // Can't reschedule into the past — mirror the grid drag-drop guard + the
      // server check. No available times → Save stays disabled.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear grid for a past day
      setSlots([]);
      return;
    }
    let cancelled = false;
    setSlotsLoading(true);
    void getAvailableTimeSlots({
      salonId,
      openingHoursRaw: deskData.salon.opening_hours,
      selectedDate: ymdToLocalNoon(selectedDay),
      staffId: selectedStaff,
      staffList: slotStaffList,
      serviceDurationMinutes: totalSpanMinutes,
      trailingBufferMinutes: bookingTiming.trailingBufferMinutes,
      closedDateYmdSet,
      shortestServiceMinutes,
      leadMinutes: deskData.salon.bookingLeadMinutes,
      timezone,
    })
      .then((res) => {
        if (cancelled) return;
        let next = res;
        // Self-occupancy patch: only on the booking's original day, force the
        // original slot to be selectable again.
        if (selectedDay === originalDayYmd) {
          let found = false;
          next = res.map((s) => {
            if (s.label === originalSlotLabel) {
              found = true;
              return { ...s, available: true };
            }
            return s;
          });
          if (!found) {
            // Original start isn't on the grid (off-grid time) — inject it.
            next = [{ label: originalSlotLabel, available: true }, ...next];
          }
          // Re-sort: getAvailableTimeSlots orders available-first then
          // chronological, but forcing the original slot to available (above)
          // leaves it in its old unavailable position (end of list), so "4:00 PM"
          // showed up after "5:45 PM". Sort again so times read in order.
          next = [...next].sort((a, b) => {
            const av = (b.available ? 1 : 0) - (a.available ? 1 : 0);
            if (av !== 0) return av;
            return (slotLabelToMinutes(a.label) ?? 0) - (slotLabelToMinutes(b.label) ?? 0);
          });
        }
        setSlots(next);
      })
      .finally(() => {
        if (!cancelled) setSlotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    deskData,
    selectedSvc,
    selectedStaff,
    selectedDay,
    minDayYmd,
    totalSpanMinutes,
    bookingTiming.trailingBufferMinutes,
    salonId,
    slotStaffList,
    closedDateYmdSet,
    shortestServiceMinutes,
    timezone,
    originalDayYmd,
    originalSlotLabel,
  ]);

  // When returning to the original day, default the selection back to the
  // original slot so an unchanged form stays a no-op.
  useEffect(() => {
    if (selectedDay === originalDayYmd) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restore original slot when the receptionist navigates back to the booking's day
      setSelectedSlotLabel(originalSlotLabel);
    }
  }, [selectedDay, originalDayYmd, originalSlotLabel]);

  const availableSlots = useMemo(() => slots.filter((s) => s.available), [slots]);

  const endTimeDisplay = useMemo(() => {
    if (!selectedSvc || totalSpanMinutes < 1) return "—";
    const startMin = slotLabelToMinutes(selectedSlotLabel);
    if (startMin == null) return "—";
    const startUtc = salonWallTimeToUtcIso(selectedDay, startMin, timezone);
    const endMs = Date.parse(startUtc) + totalSpanMinutes * 60 * 1000;
    if (Number.isNaN(endMs)) return "—";
    return formatInSalonTz(new Date(endMs).toISOString(), timezone, "time");
  }, [selectedDay, selectedSvc, selectedSlotLabel, timezone, totalSpanMinutes]);

  const priceDisplay = useMemo(() => {
    if (!selectedSvc) return "—";
    const mainCents = Number(selectedSvc.price_cents);
    if (!Number.isFinite(mainCents)) return "—";
    const addonCents = selectedAddonSvc
      ? Number(selectedAddonSvc.priceCents ?? 0)
      : 0;
    const total = mainCents + (Number.isFinite(addonCents) ? addonCents : 0);
    // P0.2 — render in the salon's currency.
    return formatCurrency(total, currency) ?? "—";
  }, [selectedSvc, selectedAddonSvc, currency]);

  const proposedStartUtc = useMemo(() => {
    const startMin = slotLabelToMinutes(selectedSlotLabel);
    if (startMin == null) return null;
    return salonWallTimeToUtcIso(selectedDay, startMin, timezone);
  }, [selectedDay, selectedSlotLabel, timezone]);

  const hasChanges =
    (proposedStartUtc != null &&
      !sameUtcInstant(proposedStartUtc, booking.start_time_utc)) ||
    selectedStaff !== originalStaff ||
    selectedService !== originalService ||
    selectedAddon !== originalAddon ||
    resourceId !== originalResourceId;

  // Block Save on a past day (mirrors the server past_date guard + the grid
  // drag-drop). Keep it day-level, NOT "selected slot must be in the freshly
  // computed list" — the slot list re-loads async on a staff/service change, so
  // a stricter check would wrongly disable Save for an unchanged-time edit.
  const isPastDay = selectedDay < minDayYmd;

  const editCopy = rcMessages.edit;
  const addonCopy = rcMessages.editAddon;

  const handleSave = async () => {
    const startMin = slotLabelToMinutes(selectedSlotLabel);
    if (startMin == null) {
      setError(editCopy.serverErrorMessage);
      return;
    }

    setSaving(true);
    setError(null);

    const newStartTimeUtc = salonWallTimeToUtcIso(selectedDay, startMin, timezone);

    const result = await editBookingAction(slug, {
      salonId,
      bookingId,
      newStartTimeUtc,
      newStaffId: selectedStaff,
      newServiceId: selectedService,
      // Empty string from the <select> means "no add-on"; map to `null`
      // so the server treats it as a removal request rather than a
      // preserve. Always-defined here (controlled select) so the
      // server takes the new-value branch even when unchanged.
      newAddonServiceId: selectedAddon === "" ? null : selectedAddon,
      // Pass bed pick only when resources are shown; undefined = keep current.
      ...(deskData?.salon.resourcesEnabled ? { newResourceId: resourceId } : {}),
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
      case "past_date":
        setError(editCopy.pastDateMessage);
        break;
      case "outside_hours":
        setError(editCopy.outsideHoursMessage);
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
            {editCopy.dateLabel}
          </span>
          <input
            type="date"
            data-testid="edit-date-input"
            // `[color-scheme:dark]` keeps the native calendar icon legible on
            // the dark drawer background.
            className={cn(
              "min-h-11 w-full rounded-lg border border-nq-muted/40 bg-nq-bg px-3 text-sm text-nq-foreground [color-scheme:dark]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40",
            )}
            min={minDayYmd}
            value={selectedDay}
            onChange={(e) => setSelectedDay(e.target.value)}
          />
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
              const priceText =
                formatServicePrice(Number(s.price_cents), currency, {
                  priceType: s.price_type,
                  priceMaxCents: s.price_max_cents,
                }) ?? "—";
              const dur = Number(s.duration_minutes);
              return (
                <option key={s.id} value={s.id}>
                  {`${s.name} · ${dur}m · ${priceText}`}
                </option>
              );
            })}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
            {addonCopy.label}
          </span>
          <select
            data-testid="edit-addon-select"
            className={cn(
              "min-h-11 w-full rounded-lg border border-nq-muted/40 bg-nq-bg px-3 text-sm text-nq-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40",
            )}
            value={selectedAddon}
            onChange={(e) => setSelectedAddon(e.target.value)}
          >
            <option value="">{addonCopy.none}</option>
            {/* Add-ons only (is_addon) — never the main-service catalog. */}
            {(deskData?.addOns ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {addonLabel(s)}
              </option>
            ))}
          </select>
        </label>

        {/* Real availability grid (reuses getAvailableTimeSlots), replacing the
            old static 30-min dropdown. */}
        <div className="block space-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
            {editCopy.timeLabel}
          </span>
          {slotsLoading ? (
            <p className="text-xs text-nq-muted" data-testid="edit-slots-loading">
              {editCopy.slotsLoading}
            </p>
          ) : availableSlots.length === 0 ? (
            <p className="text-xs text-nq-muted" data-testid="edit-no-slots">
              {editCopy.noSlots}
            </p>
          ) : (
            <div
              className="grid max-h-40 grid-cols-3 gap-1.5 overflow-y-auto rounded-lg border border-nq-muted/30 bg-nq-bg p-1.5"
              data-testid="edit-time-grid"
            >
              {availableSlots.map((s) => {
                // Stable per-slot testid keyed by minutes-from-midnight (salon
                // wall-clock), derived from the label so it never depends on the
                // localized display string. `slotLabelToMinutes` is the exact
                // inverse of `minutesToLabel`/`minutesToSlotLabel`, so a label
                // like "11:00 AM" → 660. Falls back to a label-slug only if a
                // label is somehow unparseable (defensive; shouldn't happen).
                const slotMinutes = slotLabelToMinutes(s.label);
                const slotTestId =
                  slotMinutes != null
                    ? `edit-time-slot-${slotMinutes}`
                    : `edit-time-slot-${s.label.replace(/\s+/g, "-")}`;
                return (
                <button
                  key={s.label}
                  type="button"
                  data-testid={slotTestId}
                  onClick={() => setSelectedSlotLabel(s.label)}
                  className={cn(
                    "min-h-9 rounded px-1 py-1.5 text-xs transition",
                    selectedSlotLabel === s.label
                      ? "bg-nq-primary text-white"
                      : "bg-nq-surface text-nq-foreground hover:bg-nq-primary/15",
                  )}
                >
                  {s.label}
                </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Bed picker — shown only for resource-mode salons once a slot is chosen */}
      {deskData?.salon.resourcesEnabled && selectedSlotLabel ? (
        <div data-testid="edit-bed-picker" className="block space-y-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
            {"Bed / Room"}
          </span>
          {resourceLoading ? (
            <p data-testid="edit-bed-loading" className="text-xs text-nq-muted">
              {"Checking availability…"}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                data-testid="edit-bed-auto"
                onClick={() => setResourceId(null)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition",
                  resourceId === null
                    ? "border-nq-primary bg-nq-primary text-white"
                    : "border-nq-muted/40 bg-nq-surface text-nq-foreground hover:border-nq-primary/40",
                )}
              >
                {"Auto"}
              </button>
              {resourceOptions.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  data-testid={`edit-bed-${r.id}`}
                  disabled={!r.isAvailable && resourceId !== r.id}
                  onClick={() => {
                    if (r.isAvailable) setResourceId(r.id);
                  }}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition",
                    resourceId === r.id
                      ? "border-nq-primary bg-nq-primary text-white"
                      : r.isAvailable
                        ? "border-nq-muted/40 bg-nq-surface text-nq-foreground hover:border-nq-primary/40"
                        : "cursor-not-allowed border-nq-muted/20 bg-nq-bg text-nq-muted/50 line-through",
                  )}
                >
                  🛏 {r.name}{" "}
                  <span className={r.isAvailable ? "text-green-400" : "text-nq-muted/40"}>
                    {r.isAvailable ? "✓" : "✗"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

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
          disabled={!hasChanges || isPastDay || saving || isOffline}
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
